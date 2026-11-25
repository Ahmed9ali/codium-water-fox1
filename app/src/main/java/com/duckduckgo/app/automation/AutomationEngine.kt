package com.duckduckgo.app.automation

import android.content.Context
import android.content.Intent
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.InputDevice
import android.view.MotionEvent
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.lang.ref.WeakReference
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.random.Random

data class AutomationConfig(
    val targetUrl: String,
    val groupNames: List<String>,
    val defaultGroupName: String? = null,
    val mode: String,
    val targetRepeatCount: Int = 1,
    val humanize: Boolean = false,
    val typingDelayMs: Long = 60,
    val fieldDelayMs: Long = 100,
    val settleTimeoutMs: Long = 2000,
    val pauseOnCaptcha: Boolean = true,
    val clearTabBetweenRuns: Boolean = true,
    val script: AutomationScript? = null,
)

enum class AutomationState {
    IDLE, NAVIGATING, SCANNING, FILLING, CLICKING_NEXT, WAITING_SETTLE,
    WAITING_CAPTCHA_HUMAN, WAITING_DATA_EXHAUSTED, CLEARING_DATA, COMPLETED, PAUSED, ERROR,
}

enum class RecordingPhase { Capturing, Saving }

class AutomationAsyncBridge {
    val pending = ConcurrentHashMap<String, CompletableDeferred<String>>()

    @android.webkit.JavascriptInterface
    fun resolve(callId: String, result: String?) {
        pending.remove(callId)?.complete(result ?: "")
    }
}

object AutomationEngine {
    private const val TAG = "AutomationEngine"
    private const val HUD_VIEW_TAG = "ddg_automation_hud_overlay"
    private const val ASYNC_BRIDGE_NAME = "AutomationAsync"
    private const val MAX_WAIT_MS = 300_000L
    private const val PAGE_READY_TIMEOUT_MS = 25_000L
    private const val PAGE_READY_POST_MS = 1_000L

    private val DYNAMIC_FIELDS = setOf("email", "confirmemail", "phone", "confirmphone", "username", "otp", "country", "countrycode", "dob", "dobyear", "dobmonth", "dobday")

    // Picker-style controls that must always be recorded as Field steps, never as ClickNext.
    private val FORCE_FIELD_TYPES = setOf("country", "countrycode", "currency", "state", "dob", "dobyear", "dobmonth", "dobday")

    private var currentWebView: WeakReference<WebView>? = null
    // Every WebView that was ever attached (one per tab). currentWebView can point at a background tab,
    // so anything that must act on what the person is LOOKING at asks visibleWebView().
    private val knownWebViews = mutableListOf<WeakReference<WebView>>()
    private val webViewByTab = mutableMapOf<String, WeakReference<WebView>>()

    private fun isReallyVisible(v: WebView): Boolean = try {
        v.isAttachedToWindow && v.isShown && v.windowVisibility == android.view.View.VISIBLE &&
            v.getGlobalVisibleRect(Rect()) && v.width > 0 && v.height > 0
    } catch (_: Exception) { false }

    private fun visibleWebView(): WebView? {
        knownWebViews.removeAll { it.get() == null }
        val cur = currentWebView?.get()
        if (cur != null && isReallyVisible(cur)) return cur
        val tabWv = activeTabId?.let { webViewByTab[it]?.get() }
        if (tabWv != null && isReallyVisible(tabWv)) { currentWebView = WeakReference(tabWv); return tabWv }
        val any = knownWebViews.mapNotNull { it.get() }.lastOrNull { isReallyVisible(it) }
        if (any != null) { currentWebView = WeakReference(any); return any }
        return cur ?: tabWv
    }
    private var scannerJs: String? = null
    private var appContext: Context? = null
    private var automationJob: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private val asyncBridge = AutomationAsyncBridge()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var recorderScriptHandler: ScriptHandler? = null
    private var executorScriptHandler: ScriptHandler? = null
    private var executorJs: String? = null
    private var lastRecordedAt = 0L

    @Volatile private var isInitialized = false

    private val _detectedFieldCount = MutableLiveData(0)
    val detectedFieldCount: LiveData<Int> get() = _detectedFieldCount
    private val _state = MutableLiveData(AutomationState.IDLE)
    val state: LiveData<AutomationState> get() = _state
    private val _completedCount = MutableLiveData(0)
    val completedCount: LiveData<Int> get() = _completedCount
    private val _totalTargetCount = MutableLiveData(1)
    val totalTargetCount: LiveData<Int> get() = _totalTargetCount
    private val _statusMessage = MutableLiveData("")
    val statusMessage: LiveData<String> get() = _statusMessage
    private val _captchaState = MutableLiveData(false)
    val captchaState: LiveData<Boolean> get() = _captchaState
    private val _dataExhaustedState = MutableLiveData(false)
    val dataExhaustedState: LiveData<Boolean> get() = _dataExhaustedState

    var hudVisible by mutableStateOf(false); private set
    var hudMode by mutableStateOf(HudMode.Hidden); private set
    var hudPositionTop by mutableStateOf(false); private set
    private var activeTabId: String? = null

    var hudState by mutableStateOf(AutomationState.IDLE); private set
    var hudCompleted by mutableIntStateOf(0); private set
    var hudTotal by mutableIntStateOf(1); private set
    var hudStatus by mutableStateOf(""); private set
    var hudGroupName by mutableStateOf(""); private set

    var onShowFireDialog: ((String) -> Unit)? = null
    private var fireDialogContinuation: CancellableContinuation<Unit>? = null

    private val _recordedSteps = MutableLiveData<List<RecordedStep>>(emptyList())
    val recordedSteps: LiveData<List<RecordedStep>> get() = _recordedSteps
    var hudRecordedSteps by mutableStateOf<List<RecordedStep>>(emptyList()); private set
    var hudRecordingPhase by mutableStateOf(RecordingPhase.Capturing); private set
    var hudRecordingPaused by mutableStateOf(false); private set
    var hudRecordingHost by mutableStateOf(""); private set
    var hudRecordingUrl by mutableStateOf(""); private set

    var hudAvailableScripts by mutableStateOf<List<AutomationScript>>(emptyList()); private set
    var hudSelectedScript by mutableStateOf<AutomationScript?>(null); private set
    var hudSelectedGroups by mutableStateOf<List<String>>(emptyList()); private set
    var hudSelectedDefaultGroup by mutableStateOf(""); private set
    var hudRunRepeatCount by mutableIntStateOf(1); private set
    var hudEditingScript by mutableStateOf<AutomationScript?>(null); private set

    private var currentConfig: AutomationConfig? = null
    private var pendingBrowserConfig: AutomationConfig? = null
    private var currentFieldsJson: JSONArray = JSONArray()
    private var currentActionRef: String? = null
    private var currentProfile: ActiveAutomationProfile? = null

    var onAutomationFinished: ((Int) -> Unit)? = null
    var onDataExhaustedAction: ((String) -> Unit)? = null

    fun getAsyncBridge(): AutomationAsyncBridge = asyncBridge

    fun init(context: Context) {
        if (isInitialized) return
        isInitialized = true
        appContext = context.applicationContext
        VaultRepository.init(context)
        AutomationScriptRepository.init(context)
        hudMode = HudMode.Hidden
        hudVisible = false
        hudRecordingPaused = false
        hudRecordedSteps = emptyList()
        hudRecordingPhase = RecordingPhase.Capturing
        currentWebView = null
    }

    private fun updateState(newState: AutomationState) {
        _state.postValue(newState)
        hudState = newState
        if (newState != AutomationState.IDLE) hudVisible = true
    }

    private fun updateStatus(msg: String) {
        _statusMessage.postValue(msg)
        hudStatus = msg
        Log.d(TAG, "Status: $msg")
    }

    private fun updateProgress(done: Int, total: Int) {
        _completedCount.postValue(done)
        _totalTargetCount.postValue(total)
        hudCompleted = done
        hudTotal = total
    }

    private fun checkRecorderHealth(webView: WebView) {
        if (hudMode != HudMode.Recording) return
        webView.evaluateJavascript("try { window.__automationRecorderHealth(); } catch(e) { 'error: ' + e.message; }") { res ->
            Log.d(TAG, "Health Check: $res (Kotlin paused=$hudRecordingPaused)")
        }
    }

    fun attachWebView(webView: WebView, tabId: String? = null) {
        Log.d(TAG, "attachWebView tabId=$tabId")
        currentWebView = WeakReference(webView)
        knownWebViews.removeAll { it.get() == null || it.get() === webView }
        knownWebViews.add(WeakReference(webView))
        if (tabId != null) { activeTabId = tabId; webViewByTab[tabId] = WeakReference(webView) }

        try {
            val bridge = AutomationBridge(
                tabId = tabId,
                onFieldsDetectedCallback = { json, tid -> onFieldsDetected(json, tid) },
                onPageScannedCallback = { _, _ -> },
                onFillCompletedCallback = { _, _ -> },
                onStepSettledCallback = { _, _ -> },
                onElementRecordedCallback = { json, tid -> onRecorderElementCaptured(json, tid) },
            )
            webView.addJavascriptInterface(bridge, "AutomationBridge")
            webView.addJavascriptInterface(asyncBridge, ASYNC_BRIDGE_NAME)
        } catch (e: Exception) {
            Log.e(TAG, "attachBridge failed: ${e.message}")
        }

        mountHudOverlayIfNeeded(webView)

        val config = pendingBrowserConfig
        if (config != null) {
            pendingBrowserConfig = null
            Log.d(TAG, "attachWebView: consuming pendingBrowserConfig (script=${config.script?.name})")
            startAutomation(config, navigateFirstCycle = false)
        } else if (hudMode == HudMode.Recording) {
            webView.postDelayed({
                loadRecorder()?.let { js ->
                    webView.evaluateJavascript(js) { Log.d(TAG, "Recorder re-injected after attachWebView") }
                    val pauseJs = if (hudRecordingPaused) "try{ window.__automationRecorderPause(); }catch(_){}" else "try{ window.__automationRecorderResume(); }catch(_){}"
                    webView.evaluateJavascript(pauseJs, null)
                    checkRecorderHealth(webView)
                }
            }, 200)
        } else if (hudMode != HudMode.Recording && hudMode != HudMode.Running) {
            webView.evaluateJavascript("try { window.__automationRecorderStop(); } catch(_) {}", null)
        }
    }

    fun detachWebView() {
        Log.d(TAG, "detachWebView")
        currentWebView = null
        _detectedFieldCount.postValue(0)
    }

    fun onPageFinished(webView: WebView) {
        // the page that just finished loading in a visible WebView is the one the person is using
        if (currentWebView?.get() !== webView && isReallyVisible(webView)) currentWebView = WeakReference(webView)
        if (hudMode == HudMode.Recording && hudRecordingPhase == RecordingPhase.Capturing) {
            loadRecorder()?.let { js ->
                webView.evaluateJavascript(js) { Log.d(TAG, "Recorder injected onPageFinished") }
                val pauseJs = if (hudRecordingPaused) "try{ window.__automationRecorderPause(); }catch(_){}" else "try{ window.__automationRecorderResume(); }catch(_){}"
                webView.evaluateJavascript(pauseJs, null)
                checkRecorderHealth(webView)
            }
        }
    }

    fun injectScanner() {
        val webView = currentWebView?.get() ?: return
        val js = scannerJs ?: loadScanner() ?: return
        webView.evaluateJavascript(js) {
            webView.evaluateJavascript("try { if (window.__automationScan) window.__automationScan(); } catch(_) {}", null)
        }
    }

    private fun loadScanner(): String? = try {
        appContext?.assets?.open("automation/automation_scanner.js")?.bufferedReader()?.use { it.readText() }?.also { scannerJs = it }
    } catch (e: Exception) { null }

    fun onFieldsDetected(json: String, tabId: String?) {
        try {
            if (json.contains("\"debug\"")) return
            val arr = JSONArray(json)
            currentFieldsJson = arr
            _detectedFieldCount.postValue(arr.length())
        } catch (e: Exception) { _detectedFieldCount.postValue(0) }
    }

    fun openScriptList() {
        val host = visibleWebView()?.url?.let { AutomationScriptRepository.hostOfUrl(it) } ?: ""
        hudAvailableScripts = AutomationScriptRepository.scriptsForHost(host)
        hudMode = HudMode.ScriptList
    }

    fun openRunSetup(script: AutomationScript) {
        hudSelectedScript = script
        hudSelectedGroups = script.groupNames
        hudSelectedDefaultGroup = script.defaultGroupName
        hudRunRepeatCount = 1
        hudMode = HudMode.RunSetup
    }

    fun updateRunGroups(groups: List<String>) { hudSelectedGroups = groups }
    fun updateRunDefaultGroup(group: String) { hudSelectedDefaultGroup = group }
    fun updateRunRepeat(count: Int) { hudRunRepeatCount = count.coerceIn(1, 999) }

    fun launchScriptFromList(script: AutomationScript, context: Context) {
        Log.d(TAG, "launchScriptFromList: ${script.name}, groups=${script.groupNames}")
        if (script.groupNames.isEmpty()) {
            Toast.makeText(context, "Script has no data assigned. Edit script first.", Toast.LENGTH_LONG).show()
            return
        }

        VaultRepository.init(context)

        val config = AutomationConfig(
            targetUrl = script.url,
            groupNames = script.groupNames,
            defaultGroupName = script.defaultGroupName.takeIf { it.isNotBlank() },
            mode = "series",
            targetRepeatCount = 1,
            humanize = script.humanize,
            script = script,
        )

        queueAutomationInBrowserTab(config)

        val browserIntent = com.duckduckgo.app.browser.BrowserActivity.intent(
            context = context,
            launchSource = com.duckduckgo.app.browser.mode.InAppNavigation,
            queryExtra = script.url,
        ).apply {
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        context.startActivity(browserIntent)

        scope.launch {
            delay(2000)
            val cfg = pendingBrowserConfig ?: return@launch
            if (currentWebView?.get() != null) {
                pendingBrowserConfig = null
                startAutomation(cfg, navigateFirstCycle = false)
            }
        }
    }

    fun openScriptEditor(script: AutomationScript) {
        hudEditingScript = script
        hudMode = HudMode.EditScript
    }

    fun addStepToEditingScript(step: RecordedStep) {
        val current = hudEditingScript ?: return
        val newStep = step.copy(sequenceIndex = current.steps.size + 1)
        hudEditingScript = current.copy(steps = current.steps + newStep)
    }

    fun removeStepFromEditingScript(id: String) {
        val current = hudEditingScript ?: return
        val updatedSteps = current.steps.filterNot { it.id == id }.mapIndexed { i, s -> s.copy(sequenceIndex = i + 1) }
        hudEditingScript = current.copy(steps = updatedSteps)
    }

    fun moveStepTo(id: String, newIndex: Int) {
        val current = hudEditingScript ?: return
        val steps = current.steps.toMutableList()
        val idx = steps.indexOfFirst { it.id == id }
        if (idx == -1 || idx == newIndex) return
        if (newIndex !in steps.indices) return

        val step = steps.removeAt(idx)
        steps.add(newIndex, step)

        val reindexed = steps.mapIndexed { i, s -> s.copy(sequenceIndex = i + 1) }
        hudEditingScript = current.copy(steps = reindexed)
    }

    fun updateWaitStep(id: String, newWaitMs: Long) {
        val current = hudEditingScript ?: return
        val cappedMs = newWaitMs.coerceIn(0L, MAX_WAIT_MS)
        val steps = current.steps.map {
            if (it.id == id) it.copy(waitMs = cappedMs, displayLabel = "Wait ${cappedMs / 1000}s") else it
        }
        hudEditingScript = current.copy(steps = steps)
    }

    fun saveEditingScript() {
        val current = hudEditingScript ?: return
        AutomationScriptRepository.saveScript(current)
        Toast.makeText(appContext, "Script saved", Toast.LENGTH_SHORT).show()
        hudEditingScript = null
        openScriptList()
    }

    fun startSelectedScriptRun() {
        val script = hudSelectedScript ?: return
        if (hudSelectedGroups.isEmpty()) {
            Toast.makeText(appContext, "Select a recurring data group first", Toast.LENGTH_SHORT).show()
            return
        }
        val config = AutomationConfig(
            targetUrl = script.url,
            groupNames = hudSelectedGroups,
            defaultGroupName = hudSelectedDefaultGroup.takeIf { it.isNotBlank() },
            mode = "series",
            targetRepeatCount = hudRunRepeatCount,
            humanize = script.humanize,
            script = script,
        )
        hudMode = HudMode.Running
        hudVisible = true
        currentConfig = config
        hudGroupName = config.groupNames.joinToString(", ")
        updateProgress(0, config.targetRepeatCount)
        updateState(AutomationState.NAVIGATING)
        _captchaState.postValue(false)
        _dataExhaustedState.postValue(false)

        automationJob?.cancel()
        automationJob = scope.launch { runScriptExecution(script, config, navigateFirstCycle = true) }
    }

    fun pauseAutomation() {
        automationJob?.cancel()
        updateState(AutomationState.PAUSED)
        updateStatus("Automation paused.")
        currentWebView?.get()?.evaluateJavascript("try { window.__automation_active = false; } catch(_) {}", null)
    }

    fun resumeAutomation() {
        val script = hudSelectedScript ?: return
        val config = currentConfig ?: return
        updateState(AutomationState.NAVIGATING)
        automationJob?.cancel()
        currentWebView?.get()?.evaluateJavascript("try { window.__automation_active = true; } catch(_) {}", null)
        automationJob = scope.launch {
            if (config.script != null) runScriptExecution(config.script, config, navigateFirstCycle = false)
            else runAutomationLoop(config, navigateFirstCycle = false)
        }
    }

    fun stopAutomation() {
        Log.d(TAG, "stopAutomation")
        automationJob?.cancel()
        removeExecutorScript()
        fireDialogContinuation?.cancel()
        fireDialogContinuation = null
        currentConfig = null
        pendingBrowserConfig = null
        currentProfile = null
        _captchaState.postValue(false)
        _dataExhaustedState.postValue(false)
        updateState(AutomationState.IDLE)
        updateStatus("")
        hudMode = HudMode.Hidden
        hudVisible = false
        currentWebView?.get()?.evaluateJavascript("try { window.__automation_active = false; } catch(_) {}", null)
    }

    fun continueAfterCaptchaResolution() {
        _captchaState.postValue(false)
        resumeAutomation()
    }

    fun handleDataExhaustedChoice(choice: String) {
        val script = hudSelectedScript ?: return
        val config = currentConfig ?: return
        _dataExhaustedState.postValue(false)
        if (choice == "repeat_same") {
            config.groupNames.forEach { VaultRepository.resetUsed(it) }
            updateState(AutomationState.NAVIGATING)
            automationJob?.cancel()
            currentWebView?.get()?.evaluateJavascript("try { window.__automation_active = true; } catch(_) {}", null)
            automationJob = scope.launch {
                if (config.script != null) runScriptExecution(config.script, config, navigateFirstCycle = false)
                else runAutomationLoop(config, navigateFirstCycle = false)
            }
        } else {
            stopAutomation()
            onDataExhaustedAction?.invoke(config.groupNames.firstOrNull() ?: "")
            appContext?.let { ctx ->
                val intent = Intent(ctx, AutomationActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                ctx.startActivity(intent)
            }
        }
    }

    /** [slot] is the data pool of this field: "dob" for the first date of birth on a page, "dob2" for the second... */
    private fun resolveFieldValue(step: RecordedStep, recurringProfile: ActiveAutomationProfile, defaultProfile: ActiveAutomationProfile?, slot: String = ""): String {
        if (step.customValue.isNotBlank()) return step.customValue
        // terms / newsletter / consent boxes carry no data: the step just ticks them
        if (step.fieldType.lowercase().let { it.endsWith("checkbox") || it == "checkbox" }) return "true"
        val looksLike = slot.ifBlank { VaultRepository.slotKey(step.fieldType) }
        val occurrence = 0
        val isDynamic = DYNAMIC_FIELDS.contains(VaultRepository.splitOrdinal(looksLike).first)
        val primary = if (isDynamic) recurringProfile else defaultProfile
        val fallback = if (isDynamic) defaultProfile else recurringProfile
        val v1 = primary?.resolveForField(looksLike, step.name, step.tag, occurrence)
        if (!v1.isNullOrBlank()) return v1
        return fallback?.resolveForField(looksLike, step.name, step.tag, occurrence) ?: ""
    }

    // ------------------------------------------------------------------------------------------------------------
    // Step execution. The fill / click JavaScript now lives in assets/automation/automation_executor.js (window.__ddgExec).
    // Kotlin only builds a small JSON parameter object, so the same code also runs inside iframes.
    // ------------------------------------------------------------------------------------------------------------

    // A step recorded inside an iframe keeps the frame hostname in front of its CSS selector: "@@frame:host@@css".
    private const val FRAME_PREFIX = "@@frame:"
    private const val FRAME_SUFFIX = "@@"

    private fun frameHostOf(step: RecordedStep): String? {
        val s = step.cssSelector
        if (!s.startsWith(FRAME_PREFIX)) return null
        val end = s.indexOf(FRAME_SUFFIX, FRAME_PREFIX.length)
        if (end < 0) return null
        return s.substring(FRAME_PREFIX.length, end).takeIf { it.isNotBlank() }
    }

    private fun plainCss(step: RecordedStep): String {
        val s = step.cssSelector
        if (!s.startsWith(FRAME_PREFIX)) return s
        val end = s.indexOf(FRAME_SUFFIX, FRAME_PREFIX.length)
        return if (end < 0) s else s.substring(end + FRAME_SUFFIX.length)
    }

    private fun fillParams(step: RecordedStep, value: String, humanize: Boolean, skipOpen: Boolean = false): JSONObject {
        val hints = listOf(step.placeholder, step.ariaLabel, step.displayLabel, step.fieldType)
            .map { it.trim() }.filter { it.isNotBlank() }.distinct()
        return JSONObject().apply {
            put("id", step.domId)
            put("name", step.name)
            put("css", plainCss(step))
            put("xpath", step.xpath)
            put("hints", JSONArray(hints))
            put("wanted", value)
            put("fieldType", step.fieldType.lowercase().replace(Regex("(?<=[a-z])[2-9]$"), ""))   // "dob2" -> "dob"
            put("humanize", humanize)
            if (skipOpen) put("skipOpen", true)
        }
    }

    private fun clickParams(step: RecordedStep): JSONObject {
        val labels = listOf(step.buttonLabel, step.displayLabel, step.ariaLabel)
            .map { it.trim() }
            .filter { it.isNotBlank() && !it.equals("Next button", ignoreCase = true) }
            .distinct()
        return JSONObject().apply {
            put("id", step.domId)
            put("name", step.name)
            put("css", plainCss(step))
            put("xpath", step.xpath)
            put("labels", JSONArray(labels))
        }
    }

    private fun loadExecutor(): String? = executorJs ?: try {
        appContext?.assets?.open("automation/automation_executor.js")?.bufferedReader()?.use { it.readText() }?.also { executorJs = it }
    } catch (e: Exception) { null }

    /** Registers the executor as a document-start script, so it also exists inside iframes of every page load. */
    private fun installExecutorScript(webView: WebView) {
        val js = loadExecutor() ?: run {
            Log.e(TAG, "automation_executor.js missing from assets/automation/")
            return
        }
        removeExecutorScript()
        try {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                executorScriptHandler = WebViewCompat.addDocumentStartJavaScript(webView, js, setOf("*"))
                Log.d(TAG, "Executor registered as document-start script")
            } else {
                Log.w(TAG, "DOCUMENT_START_SCRIPT not supported; steps inside iframes cannot run")
            }
        } catch (e: Exception) {
            Log.e(TAG, "executor document-start registration failed: ${e.message}")
        }
    }

    private fun removeExecutorScript() {
        try { executorScriptHandler?.remove() } catch (_: Exception) {}
        executorScriptHandler = null
    }

    /** Makes sure window.__ddgExec exists in the top page (a new page load may have wiped it). */
    private suspend fun ensureExecutor(webView: WebView) {
        val state = evaluateJsSuspend(webView, "return window.__ddgExec ? 'ok' : 'missing';", 4_000L)
        if (state.trim('"') == "ok") return
        val js = loadExecutor() ?: run {
            Log.e(TAG, "automation_executor.js missing from assets/automation/")
            return
        }
        withContext(Dispatchers.Main) { webView.evaluateJavascript(js, null) }
        delay(200)
    }

    private suspend fun execStep(webView: WebView, kind: String, params: JSONObject, frameHost: String?): JSONObject {
        ensureExecutor(webView)
        val body = "return await window.__ddgExec.run(${JSONObject.quote(kind)}, $params, ${JSONObject.quote(frameHost ?: "")});"
        return safeJsonObject(evaluateJsSuspend(webView, body, 40_000L))
    }

    /**
     * Sends a REAL touch (down + up) to the WebView at a position given in CSS pixels.
     * Pages cannot tell it from a finger, so it works where dispatched JavaScript events are ignored.
     */
    private suspend fun nativeTap(webView: WebView, n: JSONObject): Boolean {
        val density = webView.resources.displayMetrics.density.toDouble()
        val dpr = n.optDouble("dpr", density).takeIf { it > 0.0 } ?: density
        val scale = n.optDouble("vs", 1.0).takeIf { it > 0.0 } ?: 1.0
        val x = ((n.optDouble("x") - n.optDouble("vx", 0.0)) * scale * dpr).toFloat()
        val y = ((n.optDouble("y") - n.optDouble("vy", 0.0)) * scale * dpr).toFloat()
        return withContext(Dispatchers.Main) {
            if (x.isNaN() || y.isNaN() || x < 0f || y < 0f || x > webView.width || y > webView.height) {
                Log.w(TAG, "nativeTap: ($x, $y) is outside the WebView (${webView.width}x${webView.height})")
                false
            } else {
                Log.d(TAG, "nativeTap at ($x, $y) dpr=$dpr scale=$scale")
                val downTime = SystemClock.uptimeMillis()
                val down = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, x, y, 0)
                down.source = InputDevice.SOURCE_TOUCHSCREEN
                webView.dispatchTouchEvent(down)
                down.recycle()
                delay(80)
                val up = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0)
                up.source = InputDevice.SOURCE_TOUCHSCREEN
                webView.dispatchTouchEvent(up)
                up.recycle()
                true
            }
        }
    }

    private suspend fun runFieldStep(webView: WebView, step: RecordedStep, value: String, humanize: Boolean): JSONObject {
        val host = frameHostOf(step)
        var verifyHost = host
        var res = execStep(webView, "fill", fillParams(step, value, humanize), host)

        // 1) The trigger of a custom list ignored dispatched clicks (the list never opened): tap it for real, then pick.
        if (!res.optBoolean("ok", false) && res.optString("stage") == "open") {
            val trigger = res.optJSONObject("native")
            if (trigger != null && nativeTap(webView, trigger)) {
                delay(700)
                res = execStep(webView, "fill", fillParams(step, value, humanize, skipOpen = true), host)
                if (!res.optBoolean("ok", false) && res.optJSONObject("native") == null && host != null) {
                    // The list may be drawn outside the frame that holds its trigger: look for it in the top page.
                    val top = execStep(webView, "pick", fillParams(step, value, humanize), "")
                    if (top.optBoolean("ok", false) || top.optJSONObject("native") != null) { res = top; verifyHost = null }
                }
            } else {
                res = JSONObject().put("ok", false).put("err", "could not tap the list opener on screen. " + res.optString("err"))
            }
        }

        // 2) The page ignored dispatched clicks on the option: tap it for real, then check that the field changed.
        val nativeInfo = res.optJSONObject("native")
        if (!res.optBoolean("ok", false) && nativeInfo != null && res.optString("stage") != "open") {
            if (nativeTap(webView, nativeInfo)) {
                delay(500)
                val verdict = execStep(webView, "verify", JSONObject(), verifyHost)
                res = if (verdict.optBoolean("ok", false)) verdict
                else JSONObject().put("ok", false).put("err", verdict.optString("err").ifBlank { res.optString("err") })
            } else {
                res = JSONObject().put("ok", false).put("err", "option is outside the visible screen, could not tap it. " + res.optString("err"))
            }
        }
        return res
    }

    private suspend fun runScriptExecution(
        script: AutomationScript,
        config: AutomationConfig,
        navigateFirstCycle: Boolean = true,
    ) {
        val webView = currentWebView?.get() ?: run {
            Log.e(TAG, "runScriptExecution: webView is null")
            return
        }
        var completed = hudCompleted
        var isFirst = true
        // Steps recorded inside an iframe need the executor inside that frame: register it, then reload once.
        val needsFrames = script.steps.any { frameHostOf(it) != null }
        installExecutorScript(webView)
        Log.d(TAG, "runScriptExecution: script=${script.name}, steps=${script.steps.size}, target=${config.targetRepeatCount}, navigateFirstCycle=$navigateFirstCycle")

        while (completed < config.targetRepeatCount && scope.isActive) {
            // fields of the same type on one page (two dates of birth...) each need their own value
            // The 2nd one gets its own data pool: "dob", "dob2", "dob3"...
            val needs = mutableMapOf<String, Int>()
            val slotOf = Array(script.steps.size) { "" }
            val seenOfType = mutableMapOf<String, Int>()
            for ((i, st) in script.steps.withIndex()) {
                if (st.kind != StepKind.Field || st.customValue.isNotBlank()) continue
                val (base, explicit) = VaultRepository.splitOrdinal(st.fieldType)
                val ord = if (explicit > 1) explicit else (seenOfType[base] ?: 0) + 1
                if (explicit <= 1) seenOfType[base] = ord
                val slot = if (ord > 1) base + ord else base
                slotOf[i] = slot
                needs[slot] = (needs[slot] ?: 0) + 1
            }
            val activeProfile = VaultRepository.acquireMergedProfile(config.groupNames, config.mode, needs)
            if (activeProfile == null) {
                updateStatus("All selected recurring groups are empty or used.")
                _dataExhaustedState.postValue(true)
                updateState(AutomationState.WAITING_DATA_EXHAUSTED)
                return
            }

            val defaultProfile = if (!config.defaultGroupName.isNullOrBlank() && !config.groupNames.contains(config.defaultGroupName)) {
                VaultRepository.acquireMergedProfile(listOf(config.defaultGroupName), "default", needs)
            } else activeProfile

            updateState(AutomationState.NAVIGATING)
            updateStatus("Loading ${script.url}...")
            markDoc(webView)
            val loadedNew = ensureOnUrl(webView, script.url, forceReload = !isFirst || navigateFirstCycle || needsFrames)
            isFirst = false
            if (loadedNew) {
                // wait until the NEW document has replaced the old one before judging "ready"
                var w = 0L
                while (w < 6000L && docAlive(webView)) { delay(200); w += 200 }
            }
            updateStatus("Waiting for the page to finish loading...")
            waitForPageReady(webView)
            ensureExecutor(webView)
            markDoc(webView)

            var lastError = ""
            var stepIdx = 0
            var segmentStart = 0       // first step since the last navigation: replayed if the page reloads under us
            var reloadRecoveries = 0

            while (stepIdx < script.steps.size) {
                val step = script.steps[stepIdx]
                if (!scope.isActive) {
                    Log.d(TAG, "runScriptExecution: scope cancelled at step $stepIdx")
                    return
                }
                if (step.kind == StepKind.Field || step.kind == StepKind.ClickNext) {
                    if (!docAlive(webView)) {
                        // the page reloaded / navigated by itself: whatever was typed into the old page is gone
                        updateStatus("Page reloaded, waiting for it...")
                        waitForPageReady(webView)
                        ensureExecutor(webView)
                        markDoc(webView)
                        if (stepIdx > segmentStart && reloadRecoveries < 3) {
                            reloadRecoveries++
                            Log.w(TAG, "Page reloaded mid-run: redoing steps ${segmentStart + 1}..$stepIdx (attempt $reloadRecoveries)")
                            stepIdx = segmentStart
                            continue
                        }
                    } else {
                        // cheap guard: loaded and not changing right now
                        waitForPageReady(webView, quietMs = 350L, maxMs = 8_000L, checkBusy = false)
                    }
                }
                Log.d(TAG, "runScriptExecution: step ${stepIdx + 1}/${script.steps.size} kind=${step.kind} label=${step.displayLabel}")
                lastError = ""

                val stepOk: Boolean = when (step.kind) {
                    StepKind.Field -> {
                        updateState(AutomationState.FILLING)
                        updateStatus("Filling ${step.displayLabel}...")
                        val valToFill = resolveFieldValue(step, activeProfile, defaultProfile, slotOf[stepIdx])
                        if (config.humanize) delay(Random.nextLong(500, 3000))

                        val res = runFieldStep(webView, step, valToFill, config.humanize)
                        val ok = res.optBoolean("ok", false)
                        if (!ok) {
                            lastError = res.optString("err").ifBlank { "no result from page (timeout)" }
                            Log.e(TAG, "Field step failed: $lastError")
                        }
                        ok
                    }

                    StepKind.Wait -> {
                        val safeWait = step.waitMs.coerceIn(0L, MAX_WAIT_MS)
                        updateStatus("Waiting ${safeWait / 1000}s...")
                        delay(safeWait)
                        true
                    }

                    StepKind.DeleteCookies -> {
                        updateState(AutomationState.CLEARING_DATA)
                        updateStatus("Deleting site data...")
                        if (onShowFireDialog != null) {
                            try {
                                suspendCancellableCoroutine<Unit> { cont ->
                                    fireDialogContinuation = cont
                                    onShowFireDialog?.invoke(step.fieldType)
                                }
                            } catch (e: Exception) { Log.e(TAG, "Fire dialog failed: ${e.message}") }
                        }
                        try {
                            if (step.fieldType == "delete_all") clearAllData(webView)
                            else clearTabData(webView)
                        } catch (e: Exception) { Log.e(TAG, "Clear data failed: ${e.message}") }
                        delay(500)
                        true
                    }

                    StepKind.CaptchaWait -> {
                        _captchaState.postValue(true)
                        updateState(AutomationState.WAITING_CAPTCHA_HUMAN)
                        return
                    }

                    StepKind.ClickNext -> {
                        updateState(AutomationState.CLICKING_NEXT)
                        updateStatus("Clicking ${step.displayLabel}...")
                        if (config.humanize) delay(Random.nextLong(500, 3000))

                        val res = execStep(webView, "click", clickParams(step), frameHostOf(step))
                        val ok = res.optBoolean("ok", false)
                        if (ok) {
                            Log.d(TAG, "ClickNext '${step.displayLabel}' succeeded via ${res.optString("via").ifBlank { "unknown" }}")
                            updateStatus("Waiting for page...")
                            if (waitAfterClick(webView)) {
                                markDoc(webView)
                                ensureExecutor(webView)
                                segmentStart = stepIdx + 1
                            }
                        } else {
                            lastError = res.optString("err").ifBlank { "no result from page (timeout)" }
                            Log.e(TAG, "ClickNext '${step.displayLabel}' failed: $lastError")
                        }
                        ok
                    }
                }

                if (!stepOk) {
                    val msg = ("Failed at step ${stepIdx + 1}: ${step.displayLabel}" +
                        if (lastError.isNotBlank()) " — $lastError" else "").take(160)
                    Log.e(TAG, "runScriptExecution: $msg")
                    updateStatus(msg)
                    updateState(AutomationState.ERROR)
                    removeExecutorScript()
                    return
                }
                stepIdx++
            }

            VaultRepository.markProfileUsed(activeProfile)
            completed++
            hudCompleted = completed
            updateProgress(completed, config.targetRepeatCount)
            Log.d(TAG, "runScriptExecution: cycle complete $completed / ${config.targetRepeatCount}")
            delay(500)
        }

        updateState(AutomationState.COMPLETED)
        updateStatus("Finished $completed / ${config.targetRepeatCount}")
        removeExecutorScript()
        webView.evaluateJavascript("try { window.__automation_active = false; } catch(_) {}", null)
        onAutomationFinished?.invoke(completed)
    }

    private suspend fun runAutomationLoop(config: AutomationConfig, navigateFirstCycle: Boolean) {
        val webView = currentWebView?.get() ?: return
        val targetUri = if (config.targetUrl.startsWith("http")) config.targetUrl else "https://${config.targetUrl}"
        var isFirst = true
        while (hudCompleted < config.targetRepeatCount && scope.isActive) {
            val activeProfile = VaultRepository.acquireMergedProfile(config.groupNames, config.mode)
            if (activeProfile == null) {
                _dataExhaustedState.postValue(true)
                updateState(AutomationState.WAITING_DATA_EXHAUSTED)
                return
            }
            currentProfile = activeProfile

            val defaultProfile = if (!config.defaultGroupName.isNullOrBlank() && !config.groupNames.contains(config.defaultGroupName)) {
                VaultRepository.acquireMergedProfile(listOf(config.defaultGroupName), "default") ?: activeProfile
            } else {
                activeProfile
            }

            if (config.clearTabBetweenRuns && hudCompleted > 0) {
                updateState(AutomationState.CLEARING_DATA)
                updateStatus("Clearing tab data...")
                clearTabData(webView); delay(500)
            }
            updateState(AutomationState.NAVIGATING)
            if (!isFirst || navigateFirstCycle) {
                updateStatus("Loading ${config.targetUrl}...")
                withContext(Dispatchers.Main) { webView.loadUrl(targetUri) }
                delay(500)
            }
            isFirst = false
            waitForPageReady(webView)
            injectScanner(); delay(800)

            var stepSuccess = false
            var counter = 0
            while (counter < 5 && scope.isActive) {
                counter++
                updateState(AutomationState.SCANNING)
                updateStatus("Scanning form fields (Step $counter)...")
                val scanObj = try { JSONObject(evaluateJsSuspend(webView, "return JSON.stringify(await __automationScan());")) } catch (_: Exception) { JSONObject() }
                val fieldsArr = scanObj.optJSONArray("fields") ?: JSONArray()
                if (scanObj.optBoolean("captchaDetected", false) && config.pauseOnCaptcha) {
                    _captchaState.postValue(true); updateState(AutomationState.WAITING_CAPTCHA_HUMAN); return
                }
                currentActionRef = scanObj.optString("actionButtonRef").takeIf { it.isNotBlank() }
                val fillArray = JSONArray()
                for (i in 0 until fieldsArr.length()) {
                    val f = fieldsArr.getJSONObject(i)
                    val looksLike = f.optString("looksLike")
                    val matched = when {
                        looksLike == "termsCheckbox" -> "true"
                        else -> {
                            val canonicalType = VaultRepository.normalizeFieldKey(looksLike)
                            val isDynamic = DYNAMIC_FIELDS.contains(canonicalType)
                            val primary = if (isDynamic) activeProfile else defaultProfile
                            val fallback = if (isDynamic) defaultProfile else activeProfile
                            val v1 = primary?.resolveForField(canonicalType, f.optString("name"), f.optString("tag"))
                            if (!v1.isNullOrBlank()) v1 else fallback?.resolveForField(canonicalType, f.optString("name"), f.optString("tag"))
                        }
                    }
                    if (!matched.isNullOrBlank()) {
                        fillArray.put(JSONObject().apply { put("ref", f.optString("ref")); put("index", f.optInt("index", i)); put("value", matched) })
                    }
                }
                if (fillArray.length() == 0) {
                    if (counter == 1) {
                        delay(1200); injectScanner()
                        val retryObj = try { JSONObject(evaluateJsSuspend(webView, "return JSON.stringify(await __automationScan());")) } catch (_: Exception) { JSONObject() }
                        if ((retryObj.optJSONArray("fields")?.length() ?: 0) > 0) { counter--; continue }
                    }
                    stepSuccess = counter > 1; break
                }
                updateState(AutomationState.FILLING)
                updateStatus("Filling ${fillArray.length()} field(s) (Step $counter)...")
                val fillOpts = JSONObject().apply { put("typingDelayMs", config.typingDelayMs); put("fieldDelayMs", config.fieldDelayMs); put("humanize", config.humanize) }
                evaluateJsSuspend(webView, "return JSON.stringify(await __automationFill(${JSONObject.quote(fillArray.toString())}, ${JSONObject.quote(fillOpts.toString())}));")
                delay(500)
                updateState(AutomationState.CLICKING_NEXT)
                val btnName = scanObj.optString("actionButtonName").ifBlank { "Next / Submit" }
                updateStatus("Clicking '$btnName' & checking next step...")
                val clickOpts = JSONObject().apply { put("actionRef", currentActionRef ?: ""); put("settleTimeoutMs", config.settleTimeoutMs); put("pauseOnCaptcha", config.pauseOnCaptcha) }
                val settle = try { JSONObject(evaluateJsSuspend(webView, "return JSON.stringify(await __automationClickNextAndSettle(${JSONObject.quote(clickOpts.toString())}));")) } catch (_: Exception) { JSONObject() }
                if (settle.optString("verdict") == "captcha_blocked" && config.pauseOnCaptcha) {
                    _captchaState.postValue(true); updateState(AutomationState.WAITING_CAPTCHA_HUMAN); return
                }
                delay(600); waitForPageReady(webView); injectScanner(); delay(500)
                val postNav = try { JSONObject(evaluateJsSuspend(webView, "return JSON.stringify(await __automationScan());")) } catch (_: Exception) { JSONObject() }
                val postFields = postNav.optJSONArray("fields") ?: JSONArray()
                var unfilled = 0
                for (k in 0 until postFields.length()) {
                    val f = postFields.getJSONObject(k)
                    if (f.optString("looksLike", "") != "termsCheckbox" && f.optString("currentValue", "").isBlank()) unfilled++
                }
                if (unfilled > 0 && settle.optString("verdict") != "validation_error" && settle.optString("verdict") != "no_button_found") {
                    updateStatus("Moved to Step ${counter + 1} — continuing...")
                    delay(400)
                } else { stepSuccess = true; break }
            }
            if (stepSuccess) {
                VaultRepository.markProfileUsed(activeProfile)
                updateProgress(hudCompleted + 1, config.targetRepeatCount)
                updateStatus("Completed cycle ${hudCompleted} of ${config.targetRepeatCount}")
            } else {
                updateStatus("No matching fields found.")
                break
            }
            delay(1000)
        }
        updateState(AutomationState.COMPLETED)
        updateStatus("Finished $hudCompleted / ${config.targetRepeatCount} automation(s)!")
        webView.evaluateJavascript("try { window.__automation_active = false; } catch(_) {}", null)
        onAutomationFinished?.invoke(hudCompleted)
    }

    fun queueAutomationInBrowserTab(config: AutomationConfig) {
        currentConfig = config
        pendingBrowserConfig = config
        hudGroupName = config.groupNames.joinToString(", ")
        updateProgress(0, config.targetRepeatCount)
        updateState(AutomationState.NAVIGATING)
        updateStatus("Opening ${config.targetUrl} in browser tab...")
    }

    fun startAutomation(config: AutomationConfig, navigateFirstCycle: Boolean = true) {
        Log.d(TAG, "startAutomation: script=${config.script?.name}, navigateFirstCycle=$navigateFirstCycle")
        currentConfig = config
        hudGroupName = config.groupNames.joinToString(", ")
        updateProgress(0, config.targetRepeatCount)
        updateState(AutomationState.NAVIGATING)
        hudMode = HudMode.Running
        hudVisible = true
        _captchaState.postValue(false)
        _dataExhaustedState.postValue(false)
        val webView = currentWebView?.get()
        if (webView == null) {
            pendingBrowserConfig = config
            updateStatus("Waiting for browser tab...")
            return
        }
        mountHudOverlayIfNeeded(webView)
        automationJob?.cancel()
        webView.evaluateJavascript("try { window.__automation_active = true; } catch(_) {}", null)
        automationJob = scope.launch {
            val scriptToRun = config.script
            if (scriptToRun != null) {
                runScriptExecution(scriptToRun, config, navigateFirstCycle)
            } else {
                runAutomationLoop(config, navigateFirstCycle)
            }
        }
    }

    private fun clearTabData(webView: WebView) {
        try {
            val url = webView.url.orEmpty()
            if (url.isNotBlank()) {
                val cm = CookieManager.getInstance()
                cm.getCookie(url)?.split(";")?.forEach { cookie ->
                    val name = cookie.substringBefore("=").trim()
                    if (name.isNotBlank()) cm.setCookie(url, "$name=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/")
                }
                cm.flush()
            }
            webView.clearCache(true); webView.clearFormData()
            webView.evaluateJavascript("""
                (function() {
                    try { localStorage.clear(); } catch(_) {}
                    try { sessionStorage.clear(); } catch(_) {}
                    try { if (window.indexedDB && window.indexedDB.databases) window.indexedDB.databases().then(dbs => dbs.forEach(db => window.indexedDB.deleteDatabase(db.name))); } catch(_) {}
                    try { if (navigator.serviceWorker) navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister())); } catch(_) {}
                    try { if (window.caches) caches.keys().then(keys => keys.forEach(k => caches.delete(k))); } catch(_) {}
                })();
            """.trimIndent(), null)
        } catch (e: Exception) { Log.e(TAG, "Clear tab err: ${e.message}") }
    }

    private fun clearAllData(webView: WebView) {
        try {
            webView.clearCache(true); webView.clearHistory(); webView.clearFormData()
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
            WebStorage.getInstance().deleteAllData()
            webView.evaluateJavascript("""
                (function() {
                    try { localStorage.clear(); } catch(_) {}
                    try { sessionStorage.clear(); } catch(_) {}
                })();
            """.trimIndent(), null)
        } catch (e: Exception) { Log.e(TAG, "Clear all err: ${e.message}") }
    }

    fun resolveFireDialogResult() {
        fireDialogContinuation?.resumeWith(Result.success(Unit))
        fireDialogContinuation = null
    }

    private fun normalizeUrl(u: String): String =
        u.trim().substringBefore('#').removePrefix("https://").removePrefix("http://").removePrefix("www.").trimEnd('/').lowercase()

    private suspend fun ensureOnUrl(webView: WebView, targetUrl: String, forceReload: Boolean): Boolean {
        val target = normalizeUrl(targetUrl)
        if (!forceReload) {
            var waited = 0L
            while (waited < 4000L) {
                val cur = normalizeUrl(webView.url.orEmpty())
                if (cur == target || cur.startsWith(target)) {
                    Log.d(TAG, "ensureOnUrl: already on target")
                    return false
                }
                delay(250)
                waited += 250
            }
        }
        Log.d(TAG, "ensureOnUrl: loading $targetUrl")
        webView.loadUrl(if (targetUrl.startsWith("http")) targetUrl else "https://$targetUrl")
        delay(500)
        return true
    }

    /** Returns true when the click navigated / reloaded the page. */
    private suspend fun waitAfterClick(webView: WebView): Boolean {
        var waited = 0L
        while (waited < 2500L) {
            delay(250)
            waited += 250
            if (!docAlive(webView)) {
                waitForPageReady(webView)
                return true
            }
        }
        delay(300)
        return false
    }

    /** Marks the current document; the mark is gone after any navigation / reload. */
    private suspend fun markDoc(webView: WebView) {
        try { evaluateJsSuspend(webView, "window.__ddgNavMark = 1; return 'ok';", 3000L) } catch (_: Exception) {}
    }

    private suspend fun docAlive(webView: WebView): Boolean = try {
        evaluateJsSuspend(webView, "return window.__ddgNavMark ? 'y' : 'n';", 3000L).trim('"') == "y"
    } catch (_: Exception) { false }

    private fun readyProbeJs(quietMs: Long, checkBusy: Boolean): String =
        "var w=window,now=Date.now();" +
        "if(!w.__ddgMo){w.__ddgLast=now;try{new MutationObserver(function(){w.__ddgLast=Date.now();}).observe(document.documentElement,{subtree:true,childList:true,attributes:true});}catch(e){}w.__ddgMo=1;}" +
        "var busy=false;" +
        (if (checkBusy) "try{var q=document.querySelectorAll('[aria-busy=\"true\"],[role=progressbar],[class*=spinner i],[class*=loader i],[class*=loading i],[class*=skeleton i]');" +
            "for(var i=0;i<30&&i<q.length;i++){var r=q[i].getBoundingClientRect(),cs=getComputedStyle(q[i]);" +
            "if(r.width>24&&r.height>24&&cs.visibility!=='hidden'&&cs.display!=='none'&&cs.opacity!=='0'&&q[i].offsetParent!==null){busy=true;break;}}}catch(e){}" else "") +
        "return (document.readyState==='complete'&&(now-w.__ddgLast)>=" + quietMs + "&&!busy)?'ok':'wait';"

    /**
     * Waits until the page has really finished: loaded, the DOM has been quiet for [quietMs] and (optionally) no big
     * spinner / skeleton is showing. The old check accepted "interactive" and the previous page's "complete", so
     * fields were filled into a page that was about to be replaced.
     */
    private suspend fun waitForPageReady(
        webView: WebView,
        quietMs: Long = 800L,
        maxMs: Long = PAGE_READY_TIMEOUT_MS,
        checkBusy: Boolean = true,
    ) {
        var waited = 0L
        while (waited < maxMs && scope.isActive) {
            val progress = withContext(Dispatchers.Main) { webView.progress }
            val state = try {
                evaluateJsSuspend(webView, "return (function(){" + readyProbeJs(quietMs, checkBusy && waited < 12_000L) + "})();", 2500L).trim('"')
            } catch (_: Exception) { "wait" }
            if (progress >= 100 && state == "ok") {
                Log.d(TAG, "Page ready: progress=$progress waited=${waited}ms")
                return
            }
            if (waited % 2000L == 0L) Log.d(TAG, "Page loading: progress=$progress state=$state waited=${waited}ms")
            delay(200)
            waited += 200
        }
        Log.w(TAG, "Page ready timeout after ${maxMs}ms; proceeding anyway")
    }

    private suspend fun evaluateJsSuspend(webView: WebView, body: String, timeoutMs: Long = 15_000L): String {
        val callId = UUID.randomUUID().toString()
        val deferred = CompletableDeferred<String>()
        asyncBridge.pending[callId] = deferred
        val wrapped = """
            (function() {
                var __id = ${JSONObject.quote(callId)};
                function __send(v) {
                    try {
                        AutomationAsync.resolve(__id, (typeof v === 'string') ? v : JSON.stringify(v === undefined ? null : v));
                    } catch (e) {}
                }
                try {
                    Promise.resolve((async function() { ${body.trim()} })())
                        .then(__send, function(e) { __send(JSON.stringify({ok:false, err:'js error: ' + (e && e.message ? e.message : e)})); });
                } catch (e) { __send(JSON.stringify({ok:false, err:'js error: ' + e.message})); }
            })();
        """.trimIndent()
        withContext(Dispatchers.Main) { webView.evaluateJavascript(wrapped, null) }
        val result = withTimeoutOrNull(timeoutMs) { deferred.await() }
        asyncBridge.pending.remove(callId)
        if (result == null) {
            Log.w(TAG, "evaluateJsSuspend timed out after ${timeoutMs}ms (page navigating, or AutomationAsync bridge not attached before the page loaded?)")
        }
        return result ?: "{}"
    }

    private fun safeJsonObject(raw: String): JSONObject = try { JSONObject(raw) } catch (_: Exception) { JSONObject() }

    fun setActiveTab(tabId: String) {
        Log.d(TAG, "setActiveTab called: old=$activeTabId new=$tabId mode=$hudMode")
        if (activeTabId == tabId) return
        if (hudMode == HudMode.Menu) { hudMode = HudMode.Hidden; hudVisible = false }
        if (hudMode == HudMode.Recording && activeTabId != null) {
            Log.w(TAG, "setActiveTab: Cancelling recording because tab changed from $activeTabId to $tabId")
            cancelRecording()
            Toast.makeText(appContext, "Recording cancelled", Toast.LENGTH_SHORT).show()
        }
        activeTabId = tabId
        webViewByTab[tabId]?.get()?.let { currentWebView = WeakReference(it) }
        _detectedFieldCount.postValue(0)
    }

    fun clearActiveTab(tabId: String) {
        if (activeTabId != tabId) return
        activeTabId = null
        _detectedFieldCount.postValue(0)
    }

    fun toggleHudPosition() {
        hudPositionTop = !hudPositionTop
        val webView = currentWebView?.get() ?: return
        val parent = webView.parent as? ViewGroup ?: return
        val composeView = parent.findViewWithTag<ComposeView>(HUD_VIEW_TAG) ?: return
        val params = composeView.layoutParams as? FrameLayout.LayoutParams ?: return
        params.gravity = if (hudPositionTop) Gravity.TOP else Gravity.BOTTOM
        composeView.layoutParams = params
        composeView.requestLayout()
    }

    fun onOmnibarBotIconClicked() {
        when (hudMode) {
            HudMode.Recording -> return
            HudMode.Running -> { visibleWebView()?.let { mountHudOverlayIfNeeded(it); hudVisible = true } }
            HudMode.Menu -> { hudMode = HudMode.Hidden; hudVisible = false }
            HudMode.Hidden -> { visibleWebView()?.let { mountHudOverlayIfNeeded(it); hudMode = HudMode.Menu; hudVisible = true } }
            else -> { hudMode = HudMode.Hidden; hudVisible = false }
        }
    }

    fun closeHud() {
        if (hudMode == HudMode.Running) return
        hudMode = HudMode.Hidden
        hudVisible = false
    }

    private fun installRecorder(webView: WebView) {
        val js = loadRecorder() ?: run {
            Log.e(TAG, "automation_recorder.js missing from assets")
            return
        }
        removeRecorderHandler()
        try {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                recorderScriptHandler = WebViewCompat.addDocumentStartJavaScript(webView, js, setOf("*"))
                Log.d(TAG, "Recorder registered as document-start script")
            } else {
                Log.w(TAG, "DOCUMENT_START_SCRIPT not supported; relying on onPageFinished re-injection")
            }
        } catch (e: Exception) {
            Log.e(TAG, "document-start registration failed: ${e.message}")
        }
        webView.evaluateJavascript(js) { Log.d(TAG, "Recorder injected into current page") }
    }

    private fun removeRecorderHandler() {
        try { recorderScriptHandler?.remove() } catch (_: Exception) {}
        recorderScriptHandler = null
    }

    fun startRecording() {
        Log.d(TAG, "startRecording called. Current mode=$hudMode")
        if (hudMode == HudMode.Recording) {
            currentWebView?.get()?.let { installRecorder(it) }
            hudRecordingPaused = false
            startRecorderPoll()
            currentWebView?.get()?.evaluateJavascript("try{ window.__automationRecorderResume(); }catch(_){}", null)
            return
        }
        val webView = visibleWebView() ?: run {
            Log.e(TAG, "startRecording: Failed, currentWebView is null")
            return
        }
        webView.evaluateJavascript("try { window.__automationRecorderStop(); } catch(_) {}", null)
        webView.evaluateJavascript("try { window.__automation_active = false; } catch(_) {}", null)
        val url = webView.url.orEmpty()
        hudRecordingHost = AutomationScriptRepository.hostOfUrl(url)
        hudRecordingUrl = url
        hudRecordedSteps = emptyList()
        hudRecordingPaused = false
        hudRecordingPhase = RecordingPhase.Capturing
        hudMode = HudMode.Recording
        hudVisible = true
        Log.d(TAG, "startRecording: url=$url, host=$hudRecordingHost")
        installRecorder(webView)
        startRecorderPoll()
        webView.postDelayed({
            if (hudMode == HudMode.Recording && hudRecordingPhase == RecordingPhase.Capturing) {
                loadRecorder()?.let { webView.evaluateJavascript(it) { Log.d(TAG, "Recorder injected (delayed in startRecording)") } }
                checkRecorderHealth(webView)
                reloadFramesForRecorder(webView)
            }
        }, 600)
    }

    /**
     * The recorder reaches iframes through the document-start script, which only applies to frames that load AFTER it is
     * registered. Instead of asking for a full page reload (which would close a login modal), reload only the visible
     * http(s) iframes; the page itself and its modal state stay as they are.
     */
    private fun reloadFramesForRecorder(webView: WebView) {
        webView.evaluateJavascript(
            "(function(){var n=0;try{var fs=document.querySelectorAll('iframe');for(var i=0;i<fs.length;i++){var f=fs[i];var r=f.getBoundingClientRect();var s=f.getAttribute('src')||'';if(r.width>80&&r.height>80&&/^(https?:)?\\/\\//i.test(s)){f.src=f.src;n++;}}}catch(e){}return n;})()"
        ) { v ->
            val n = v?.trim('"')?.toIntOrNull() ?: 0
            if (n > 0 && hudMode == HudMode.Recording) {
                Toast.makeText(appContext, "Attaching to $n embedded frame(s)...", Toast.LENGTH_SHORT).show()
            }
        }
    }

    fun pauseRecording() {
        Log.d(TAG, "pauseRecording called (mode=$hudMode)")
        if (hudMode != HudMode.Recording) return
        hudRecordingPaused = true
        currentWebView?.get()?.evaluateJavascript("try { window.__automationRecorderPause(); } catch(_) {}", null)
    }

    fun resumeRecording() {
        Log.d(TAG, "resumeRecording called (mode=$hudMode)")
        if (hudMode != HudMode.Recording) return
        hudRecordingPaused = false
        currentWebView?.get()?.evaluateJavascript("try { window.__automationRecorderResume(); } catch(_) {}", null)
    }

    fun cancelRecording() {
        Log.d(TAG, "cancelRecording called")
        currentWebView?.get()?.evaluateJavascript("try { window.__automationRecorderStop(); } catch(_) {}", null)
        removeRecorderHandler()
        hudRecordedSteps = emptyList()
        hudRecordingPaused = false
        hudRecordingPhase = RecordingPhase.Capturing
        hudMode = HudMode.Hidden
        hudVisible = false
    }

    private fun sanitizeString(s: String, maxLen: Int): String = try {
        s.filter { c -> !c.isISOControl() || c == '\n' || c == '\t' }.take(maxLen)
    } catch (_: Exception) { "" }

    private fun peekRecorderSeq(json: String): Int = try {
        JSONObject(json).optInt("seq", -1)
    } catch (_: Exception) { -1 }

    /** Tells the page what happened to a captured tap, so the on-screen toast shows the truth. */
    private fun ackRecorder(seq: Int, ok: Boolean, msg: String) {
        if (seq < 0) return
        val webView = currentWebView?.get() ?: return
        val safe = msg.replace("\\", " ").replace("'", " ").replace("\n", " ").replace("\r", " ")
        webView.post {
            webView.evaluateJavascript(
                "try{ if (window.__automationRecorderAck) window.__automationRecorderAck($seq, $ok, '$safe'); }catch(_){}",
                null
            )
        }
    }

    private var recorderPoll: Runnable? = null

    /**
     * Pulls queued taps out of the page with evaluateJavascript. This works even when window.AutomationBridge
     * is not visible to the current document, so recording never needs a page refresh to start.
     */
    private fun startRecorderPoll() {
        stopRecorderPoll()
        val r = object : Runnable {
            override fun run() {
                if (hudMode != HudMode.Recording) { recorderPoll = null; return }
                pollRecorderOnce()
                mainHandler.postDelayed(this, 150)
            }
        }
        recorderPoll = r
        mainHandler.postDelayed(r, 400)
    }

    private fun stopRecorderPoll() {
        recorderPoll?.let { mainHandler.removeCallbacks(it) }
        recorderPoll = null
    }

    private fun pollRecorderOnce() {
        val webView = currentWebView?.get() ?: return
        webView.evaluateJavascript(
            "(function(){try{return window.__automationRecorderDrain ? window.__automationRecorderDrain() : '';}catch(e){return '';}})()"
        ) { raw ->
            try {
                if (raw.isNullOrBlank() || raw == "null") return@evaluateJavascript
                val text = JSONTokener(raw).nextValue() as? String ?: return@evaluateJavascript
                if (text.isBlank()) return@evaluateJavascript
                val arr = JSONArray(text)
                Log.d(TAG, "recorder poll: pulled ${arr.length()} queued tap(s) from the page")
                for (i in 0 until arr.length()) {
                    onRecorderElementCaptured(arr.getJSONObject(i).toString(), activeTabId)
                }
            } catch (e: Exception) {
                Log.w(TAG, "recorder poll parse fail: ${e.message}")
            }
        }
    }

    fun onRecorderElementCaptured(json: String, tabId: String?) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post { onRecorderElementCaptured(json, tabId) }
            return
        }
        val seq = peekRecorderSeq(json)

        if (hudMode != HudMode.Recording) {
            Log.w(TAG, "DROPPED tap: mode=$hudMode is not Recording (tabId=$tabId)")
            ackRecorder(seq, false, "mode=$hudMode")
            return
        }
        if (hudRecordingPaused) {
            Log.w(TAG, "DROPPED tap: hudRecordingPaused=true (tabId=$tabId)")
            ackRecorder(seq, false, "recording is paused")
            return
        }

        try {
            val obj = JSONObject(json)
            val kindRaw = obj.optString("kind", "Field")
            val looksLike = sanitizeString(obj.optString("looksLike", ""), 50)

            // Picker-style controls (country, country code, currency, state, DOB parts) are always Fields,
            // even if the page reported them as a click. This prevents "Country/Region" becoming a Next button.
            val forceField = FORCE_FIELD_TYPES.contains(looksLike.lowercase())

            val stepKind = if (forceField) {
                StepKind.Field
            } else {
                when (kindRaw.lowercase()) {
                    "clicknext", "click", "button", "link", "submit", "anchor" -> StepKind.ClickNext
                    "wait" -> StepKind.Wait
                    "captchawait" -> StepKind.CaptchaWait
                    else -> StepKind.Field
                }
            }
            val cssSelector = sanitizeString(obj.optString("cssSelector", ""), 500)
            val xpathVal = sanitizeString(obj.optString("xpath", ""), 500)
            val domId = sanitizeString(obj.optString("domId", ""), 100)
            val name = sanitizeString(obj.optString("name", ""), 100)

            if (cssSelector.isBlank() && xpathVal.isBlank() && domId.isBlank() && name.isBlank()) {
                Log.w(TAG, "DROPPED tap: Rejecting step with no identifying selector")
                ackRecorder(seq, false, "no selector")
                return
            }

            // A tap inside an iframe: remember the frame hostname in front of the selector (see FRAME_PREFIX).
            val frameHost = sanitizeString(obj.optString("frameHost", ""), 120)
            if (frameHost.isNotBlank() && obj.optInt("frameDepth", 1) > 1) {
                Log.w(TAG, "step recorded in a nested frame (depth ${obj.optInt("frameDepth")}); replay supports one frame level only")
            }
            val storedCss = if (frameHost.isNotBlank()) "$FRAME_PREFIX$frameHost$FRAME_SUFFIX$cssSelector" else cssSelector

            val last = hudRecordedSteps.lastOrNull()
            val now = System.currentTimeMillis()
            if (last != null && last.kind == stepKind && last.cssSelector == storedCss &&
                last.xpath == xpathVal && now - lastRecordedAt < 600
            ) {
                Log.d(TAG, "DROPPED tap: Ignoring duplicate recorder event (fast re-click)")
                ackRecorder(seq, false, "duplicate tap")
                return
            }
            lastRecordedAt = now

            val plainType = if (stepKind == StepKind.Field) FieldTypeMapper.normalizeLooksLike(looksLike) else ""
            // A second field of the same type on this page becomes "dob2", "email2"...: it has its own data pool.
            val sameBefore = if (plainType.isBlank()) 0 else hudRecordedSteps.count {
                it.kind == StepKind.Field && VaultRepository.splitOrdinal(it.fieldType).first == VaultRepository.splitOrdinal(plainType).first
            }
            val ordinal = sameBefore + 1
            val canonicalType = if (ordinal in 2..9) plainType + ordinal else plainType
            var rawLabel = if (stepKind == StepKind.ClickNext) obj.optString("buttonLabel", "Next button")
                           else FieldTypeMapper.fieldRowLabel(plainType, obj.optString("displayLabel", ""))
            if (ordinal in 2..9 && stepKind == StepKind.Field) {
                rawLabel = if (rawLabel.endsWith(" Input")) rawLabel.removeSuffix(" Input") + " $ordinal Input" else "$rawLabel $ordinal"
            }
            val displayLabel = sanitizeString(rawLabel, 100)
            val step = RecordedStep(
                sequenceIndex = hudRecordedSteps.size + 1,
                kind = stepKind,
                fieldType = canonicalType,
                displayLabel = displayLabel,
                tag = sanitizeString(obj.optString("tag"), 30),
                domType = sanitizeString(obj.optString("domType"), 30),
                name = name,
                domId = domId,
                placeholder = sanitizeString(obj.optString("placeholder"), 100),
                ariaLabel = sanitizeString(obj.optString("ariaLabel"), 100),
                cssSelector = storedCss,
                xpath = xpathVal,
                index = obj.optInt("index", -1),
                buttonLabel = sanitizeString(obj.optString("buttonLabel"), 100),
                verified = stepKind != StepKind.Field || canonicalType.isNotBlank(),
            )
            hudRecordedSteps = hudRecordedSteps + step
            Log.d(TAG, "Recorded step #${step.sequenceIndex} kind=$stepKind label=$displayLabel")
            ackRecorder(seq, true, "#${step.sequenceIndex}" + if (frameHost.isNotBlank()) " (in frame)" else "")
        } catch (e: Exception) {
            Log.e(TAG, "onRecorderElementCaptured parse fail: ${e.message}")
            ackRecorder(seq, false, "error: ${e.message}")
        }
    }

    fun removeRecordedStep(id: String) {
        if (hudMode != HudMode.Recording) return
        hudRecordedSteps = hudRecordedSteps.filterNot { it.id == id }.mapIndexed { i, s -> s.copy(sequenceIndex = i + 1) }
    }

    fun assignFieldTypeToStep(id: String, canonicalType: String) {
        if (hudMode != HudMode.Recording) return
        hudRecordedSteps = hudRecordedSteps.map { if (it.id == id) it.copy(fieldType = canonicalType, displayLabel = FieldTypeMapper.fieldRowLabel(canonicalType, it.displayLabel), verified = true) else it }
    }

    fun stopRecordingAndPromptSave() {
        if (hudRecordedSteps.isEmpty()) { cancelRecording(); return }
        currentWebView?.get()?.evaluateJavascript("try { window.__automationRecorderStop(); } catch(_) {}", null)
        removeRecorderHandler()
        hudRecordingPhase = RecordingPhase.Saving
    }

    fun cancelSaveRecording() {
        hudRecordingPhase = RecordingPhase.Capturing
        currentWebView?.get()?.let { wv -> installRecorder(wv) }
    }

    fun saveRecording(name: String) {
        if (hudRecordingPhase != RecordingPhase.Saving) return
        val ctx = appContext ?: return
        if (hudRecordingHost.isBlank() || hudRecordedSteps.isEmpty()) return
        currentWebView?.get()?.evaluateJavascript("try { window.__automationRecorderStop(); } catch(_) {}", null)
        removeRecorderHandler()
        val finalName = name.trim().ifBlank { "${hudRecordingHost} Script" }
        val script = AutomationScript(
            id = UUID.randomUUID().toString(), url = hudRecordingUrl, host = hudRecordingHost,
            name = finalName, groupNames = emptyList(), humanize = false, createdAt = System.currentTimeMillis(),
            updatedAt = System.currentTimeMillis(), steps = hudRecordedSteps
        )
        AutomationScriptRepository.saveScript(script)
        Toast.makeText(ctx, "Script saved: $finalName", Toast.LENGTH_SHORT).show()
        hudRecordedSteps = emptyList()
        hudRecordingPaused = false
        hudRecordingPhase = RecordingPhase.Capturing
        hudMode = HudMode.Menu
        hudVisible = true
    }

    private fun loadRecorder(): String? = try {
        appContext?.assets?.open("automation/automation_recorder.js")?.bufferedReader()?.use { it.readText() }
    } catch (e: Exception) { null }

    private fun mountHudOverlayIfNeeded(webView: WebView, retry: Int = 0) {
        val parent = webView.parent as? ViewGroup
        if (parent == null) {
            if (retry < 10) {
                Log.w(TAG, "mountHudOverlayIfNeeded: no parent yet (retry=$retry)")
                webView.postDelayed({ mountHudOverlayIfNeeded(webView, retry + 1) }, 100)
            } else {
                Log.e(TAG, "mountHudOverlayIfNeeded: giving up after $retry retries")
            }
            return
        }
        if (parent.findViewWithTag<ComposeView>(HUD_VIEW_TAG) != null) {
            Log.d(TAG, "mountHudOverlayIfNeeded: HUD already mounted")
            return
        }
        Log.d(TAG, "mountHudOverlayIfNeeded: mounting in ${parent::class.java.simpleName}")

        val composeView = ComposeView(webView.context).apply {
            tag = HUD_VIEW_TAG
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
            isClickable = false
            isFocusable = false
            setContent {
                AutomationThemeWrapper(isLightMode = resolveDuckDuckGoIsLight(context)) {
                    BrowserTabAutomationHud()
                }
            }
        }
        val params = if (parent is FrameLayout) {
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { gravity = if (hudPositionTop) Gravity.TOP else Gravity.BOTTOM }
        } else {
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        parent.addView(composeView, params)

        composeView.bringToFront()
        Log.d(TAG, "mountHudOverlayIfNeeded: HUD mounted and brought to front")
    }
}