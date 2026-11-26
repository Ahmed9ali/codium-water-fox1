package com.duckduckgo.app.automation

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.mutableStateOf
import org.json.JSONArray
import org.json.JSONObject
import kotlin.random.Random

enum class DataGroupType {
    DEFAULT,
    RECURRING
}

data class VaultEntry(
    val fieldType: String,
    val value: String,
    val used: Boolean = false,
)

data class VaultGroup(
    val name: String,
    val entries: List<VaultEntry>,
    val pinned: Boolean = false,
    val type: DataGroupType = DataGroupType.RECURRING
) {
    val unusedCount: Int get() = entries.count { !it.used }
    val usedCount: Int get() = entries.count { it.used }
}

data class ActiveAutomationProfile(
    val consumed: Map<String, List<Int>>,
    val fields: Map<String, String>,
    /** Every value taken for a type, in order: the 2nd field of the same type on a page uses the 2nd value. */
    val lists: Map<String, List<String>> = emptyMap(),
) {
    /** Exact pool named like a page field ("monthlyvolume"), no guessing. */
    fun fieldByName(name: String): String? {
        if (name.isBlank()) return null
        return fields[VaultRepository.normalizeFieldKey(name)]?.takeIf { it.isNotBlank() }
    }

    fun resolveForField(looksLike: String, fieldName: String = "", tag: String = "", occurrence: Int = 0): String? {
        // "dob2" = the second date-of-birth field of a page. It has its own pool ("dob2" entries); when there is none,
        // it takes the second value of the plain pool, never the same value as the first field.
        val (baseKey, ordinal) = VaultRepository.splitOrdinal(looksLike)
        if (ordinal > 1) {
            fields[baseKey + ordinal]?.let { if (it.isNotBlank()) return it }
            lists[baseKey]?.getOrNull(ordinal - 1)?.let { if (it.isNotBlank()) return it }
            // 2nd date of birth: day / month / year come out of the "dob2" value (or the 2nd plain "dob" value).
            // They are NEVER taken from the first date: two dates of birth must differ.
            val part = when (baseKey) { "dobyear" -> 'y'; "dobmonth" -> 'm'; "dobday" -> 'd'; else -> null }
            if (part != null) {
                val src = fields["dob$ordinal"] ?: lists["dob"]?.getOrNull(ordinal - 1)
                return datePartOfDob(src, part)
            }
            if (baseKey == "dob") return null
        }
        val normalizedType = baseKey

        // 0. Same field type twice on one page (two dates of birth, two e-mails...): use the matching entry
        if (occurrence > 0) {
            lists[normalizedType]?.getOrNull(occurrence)?.let { if (it.isNotBlank()) return it }
        }

        // 1. Direct match
        fields[normalizedType]?.let { if (it.isNotBlank()) return it }

        // 2. Match by raw field name
        if (fieldName.isNotBlank() && ordinal <= 1) {
            val normalizedName = VaultRepository.normalizeFieldKey(fieldName)
            fields[normalizedName]?.let { if (it.isNotBlank()) return it }
        }

        // 3. Fuzzy matching is unsafe for semantically distinct selectors such as
        // country vs country-code and DOB vs birth-year. Keep those exact-only.
        val exactOnlyTypes = setOf("country", "countrycode", "dob", "dobyear", "dobmonth", "dobday")
        if (normalizedType !in exactOnlyTypes && ordinal <= 1) {
            val fuzzyMatch = fields.entries.firstOrNull {
                it.value.isNotBlank() && it.key.isNotBlank() &&
                    (it.key.contains(normalizedType) || normalizedType.contains(it.key))
            }
            if (fuzzyMatch != null) return fuzzyMatch.value
        }

        // 4. Strict fallbacks
        return when (normalizedType) {
            "confirmpassword" -> fields["password"]
            "confirmemail" -> fields["email"]
            "confirmphone" -> fields["phone"]
            "dobyear" -> fields["birthyear"] ?: fields["yearofbirth"] ?: datePartOfDob(fields["dob"], 'y')
            "dobmonth" -> fields["birthmonth"] ?: datePartOfDob(fields["dob"], 'm')
            "dobday" -> fields["birthday"] ?: datePartOfDob(fields["dob"], 'd')
            "countrycode" -> fields["dialcode"] ?: fields["isdcode"] ?: fields["phonecode"]
            "firstname" -> fields["fullname"]?.trim()?.substringBefore(" ") ?: fields["username"]
            "middlename" -> null 
            "lastname" -> fields["surname"] ?: fields["fullname"]?.trim()?.substringAfter(" ", "")?.takeIf { it.isNotBlank() }
            "surname" -> fields["lastname"] ?: fields["fullname"]?.trim()?.substringAfter(" ", "")?.takeIf { it.isNotBlank() }
            "fullname" -> {
                val first = fields["firstname"].orEmpty()
                val last = fields["lastname"] ?: fields["surname"].orEmpty()
                "$first $last".trim().ifBlank { fields["username"] ?: fields["email"]?.substringBefore("@") }
            }
            "username" -> fields["email"]?.substringBefore("@") ?: fields["fullname"]?.replace(" ", "_")
            "website" -> fields["url"] ?: fields["text"]
            "company" -> fields["text"]
            "message" -> fields["message"] ?: fields["subject"] ?: fields["text"]
            "subject" -> fields["subject"] ?: fields["message"] ?: fields["text"]
            // Never substitute generic text for structured selectors. A country
            // name, dial code, and birth-year value must come from their own pool.
            "country", "countrycode", "dob", "dobyear", "dobmonth", "dobday" -> null
            "text" -> {
                if (tag == "textarea") {
                    fields["message"] ?: fields["text"] ?: fields["subject"]
                } else {
                    fields["text"] ?: fields["subject"] ?: fields["message"]
                }
            }
            else -> fields["text"]
        }
    }
}

/** Day / month / year out of a stored "dob" value: a full date, or a bare number that already is that part. */
internal fun datePartOfDob(raw: String?, part: Char): String? {
    val v = raw?.trim().orEmpty()
    if (v.isEmpty()) return null
    Regex("^(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})$").matchEntire(v)?.let { m ->
        return when (part) { 'y' -> m.groupValues[1]; 'm' -> m.groupValues[2].toInt().toString(); else -> m.groupValues[3].toInt().toString() }
    }
    Regex("^(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{4})$").matchEntire(v)?.let { m ->
        val a = m.groupValues[1].toInt(); val b = m.groupValues[2].toInt()
        val (d, mo) = if (b > 12) b to a else a to b   // dd/mm/yyyy unless the second number cannot be a month
        return when (part) { 'y' -> m.groupValues[3]; 'm' -> mo.toString(); else -> d.toString() }
    }
    val n = v.toIntOrNull() ?: return null
    return when (part) {
        'y' -> if (v.length == 4 && n in 1900..2100) v else null
        'm' -> if (n in 1..12) v else null
        else -> if (n in 1..31) v else null
    }
}

object VaultRepository {
    private const val PREFS_NAME = "automation_vault"
    private const val KEY_GROUPS = "groups"
    private const val MAX_PINNED = 5

    private var prefs: SharedPreferences? = null

    val groups = mutableStateOf<List<VaultGroup>>(emptyList())

    fun init(context: Context) {
        if (prefs != null) return
        prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        groups.value = load()
    }

    fun getDefaultGroups(): List<VaultGroup> = groups.value.filter { it.type == DataGroupType.DEFAULT }
    fun getRecurringGroups(): List<VaultGroup> = groups.value.filter { it.type == DataGroupType.RECURRING }

    fun addGroup(name: String, rawText: String, type: DataGroupType, pinned: Boolean = false) {
        val trimmedName = name.trim().ifBlank { "Group ${System.currentTimeMillis() % 10000}" }
        val entries = parseEntries(rawText, trimmedName)
        val existing = groups.value.firstOrNull { it.name.equals(trimmedName, ignoreCase = true) }
        if (existing != null) {
            groups.value = groups.value.map { g ->
                if (g.name.equals(trimmedName, ignoreCase = true)) g.copy(entries = g.entries + entries) else g
            }
        } else {
            val finalPinned = pinned && groups.value.count { it.pinned } < MAX_PINNED
            val group = VaultGroup(name = trimmedName, entries = entries, pinned = finalPinned, type = type)
            groups.value = groups.value + group
        }
        save()
    }

    fun addSpecificEntries(groupName: String, fieldType: String, rawValues: String) {
        val normalizedType = slotKey(fieldType)
        val newEntries = rawValues
            .lines()
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .map { line ->
                val parts = line.split(":", limit = 2)
                if (parts.size == 2 && parts[0].trim().length in 2..20 && !parts[0].contains("@") && !parts[0].contains(" ")) {
                    VaultEntry(fieldType = slotKey(parts[0]), value = parts[1].trim(), used = false)
                } else {
                    VaultEntry(fieldType = normalizedType, value = line, used = false)
                }
            }
        if (newEntries.isEmpty()) return
        val fixedEntries = newEntries.map { repairEntry(it, groupName) }

        groups.value = groups.value.map { g ->
            if (g.name == groupName) g.copy(entries = g.entries + fixedEntries) else g
        }
        save()
    }

    /**
     * Adds already-made values (see [DataGenerator]) to a group WITHOUT parsing them: a value such as "10:30" or
     * "https://x.com" must stay one value, and every entry gets exactly [fieldType] ("dob2" keeps its pool).
     */
    fun addGeneratedEntries(groupName: String, fieldType: String, values: List<String>) {
        val key = slotKey(fieldType)
        val fresh = values.map { it.trim() }.filter { it.isNotEmpty() }.map { repairEntry(VaultEntry(fieldType = key, value = it, used = false), groupName) }
        if (fresh.isEmpty()) return
        groups.value = groups.value.map { g -> if (g.name == groupName) g.copy(entries = g.entries + fresh) else g }
        save()
    }

    fun updateEntry(groupName: String, index: Int, newFieldType: String, newValue: String) {
        val normalizedType = slotKey(newFieldType)
        groups.value = groups.value.map { g ->
            if (g.name != groupName) return@map g
            val updated = g.entries.toMutableList()
            if (index in updated.indices) {
                updated[index] = repairEntry(updated[index].copy(fieldType = normalizedType, value = newValue), g.name)
            }
            g.copy(entries = updated)
        }
        save()
    }

    fun appendEntriesToGroup(groupName: String, rawText: String) {
        val group = getGroup(groupName)
        if (group == null) {
            addGroup(groupName, rawText, DataGroupType.RECURRING)
            return
        }
        val newEntries = parseEntries(rawText, groupName)
        groups.value = groups.value.map { g ->
            if (g.name == groupName) g.copy(entries = g.entries + newEntries) else g
        }
        save()
    }

    fun removeGroup(name: String) {
        groups.value = groups.value.filterNot { it.name == name }
        save()
    }

    fun renameGroup(oldName: String, newName: String) {
        val trimmed = newName.trim()
        if (trimmed.isBlank()) return
        groups.value = groups.value.map { g -> if (g.name == oldName) g.copy(name = trimmed) else g }
        save()
    }

    fun togglePin(name: String) {
        val current = groups.value.firstOrNull { it.name == name } ?: return
        if (!current.pinned && groups.value.count { it.pinned } >= MAX_PINNED) return
        groups.value = groups.value.map { g -> if (g.name == name) g.copy(pinned = !g.pinned) else g }
        val pinned = groups.value.filter { it.pinned }
        val unpinned = groups.value.filterNot { it.pinned }
        groups.value = pinned + unpinned
        save()
    }

    fun canPinMore(): Boolean = groups.value.count { it.pinned } < MAX_PINNED

    fun getGroup(name: String): VaultGroup? = groups.value.firstOrNull { it.name == name }

    fun updateEntryValue(groupName: String, index: Int, newValue: String) {
        groups.value = groups.value.map { g ->
            if (g.name != groupName) return@map g
            val updated = g.entries.toMutableList()
            if (index in updated.indices) updated[index] = updated[index].copy(value = newValue)
            g.copy(entries = updated)
        }
        save()
    }

    fun toggleEntryUsed(groupName: String, index: Int) {
        groups.value = groups.value.map { g ->
            if (g.name != groupName) return@map g
            val updated = g.entries.toMutableList()
            if (index in updated.indices) {
                val current = updated[index]
                updated[index] = current.copy(used = !current.used)
            }
            g.copy(entries = updated)
        }
        save()
    }

    fun deleteEntry(groupName: String, index: Int) {
        groups.value = groups.value.map { g ->
            if (g.name != groupName) return@map g
            val updated = g.entries.toMutableList()
            if (index in updated.indices) updated.removeAt(index)
            g.copy(entries = updated)
        }
        save()
    }

    fun resetUsed(groupName: String) {
        groups.value = groups.value.map { g ->
            if (g.name != groupName) return@map g
            g.copy(entries = g.entries.map { it.copy(used = false) })
        }
        save()
    }

    fun markProfileUsed(profile: ActiveAutomationProfile) {
        if (profile.consumed.isEmpty()) return
        groups.value = groups.value.map { g ->
            val indices = profile.consumed[g.name] ?: return@map g
            val indexSet = indices.toSet()
            val updated = g.entries.mapIndexed { idx, entry -> 
                if (idx in indexSet) entry.copy(used = true) else entry 
            }
            g.copy(entries = updated)
        }
        save()
    }

    fun unusedProfileCount(groupName: String): Int {
        val group = getGroup(groupName) ?: return 0
        val unused = group.entries.filter { !it.used }
        if (unused.isEmpty()) return 0
        val countsByType = unused.groupingBy { effectiveType(it, group.name) }.eachCount()
        return countsByType.values.maxOrNull() ?: 0
    }

    fun hasUnusedData(groupName: String): Boolean = unusedProfileCount(groupName) > 0

    /**
     * [needs] says how many fields of each type the script has (e.g. dob -> 2). That many unused entries are taken
     * for the type, so two date-of-birth boxes get two different values.
     */
    fun acquireMergedProfile(groupNames: List<String>, mode: String, needs: Map<String, Int> = emptyMap()): ActiveAutomationProfile? {
        val chosenFields = mutableMapOf<String, String>()
        val chosenLists = mutableMapOf<String, MutableList<String>>()
        val consumed = mutableMapOf<String, List<Int>>()
        var anyFound = false

        // every pool ("dob", "dob2", "email"...) that still has an unused entry in at least one selected group
        val poolsPresent = mutableSetOf<String>()
        for (name in groupNames) {
            val g = getGroup(name) ?: continue
            g.entries.forEach { e -> if (!e.used && e.value.isNotBlank()) poolsPresent.add(effectiveType(e, g.name)) }
        }

        for (name in groupNames) {
            val group = getGroup(name) ?: continue
            val indexedUnused = group.entries.mapIndexedNotNull { index, entry ->
                if (!entry.used && entry.value.isNotBlank()) index to entry else null
            }
            if (indexedUnused.isEmpty()) continue
            anyFound = true

            val byType = linkedMapOf<String, MutableList<Pair<Int, VaultEntry>>>()
            for (pair in indexedUnused) {
                val key = effectiveType(pair.second, group.name)
                byType.getOrPut(key) { mutableListOf() }.add(pair)
            }

            // a "dob2" field with no "dob2" pool in this group borrows the next entry of the plain "dob" pool
            // (only when NO selected group has an unused "dob2" entry; a used-up "Dob2" group counts as missing)
            val extra = mutableMapOf<String, Int>()
            for (nk in needs.keys) {
                val (b, o) = splitOrdinal(nk)
                if (o > 1 && nk !in poolsPresent) extra[b] = (extra[b] ?: 0) + 1
            }
            val groupConsumed = mutableListOf<Int>()
            val maxBucketSize = byType.values.maxOfOrNull { it.size } ?: 1
            val randomSlot = if (maxBucketSize > 1) Random.nextInt(maxBucketSize) else 0

            for ((typeKey, candidates) in byType) {
                if (candidates.isEmpty()) continue
                val want = ((needs[typeKey] ?: 1) + (extra[typeKey] ?: 0) - (chosenLists[typeKey]?.size ?: 0)).coerceAtLeast(1).coerceAtMost(candidates.size)
                val ordered = when (mode.lowercase()) {
                    "bottom_up", "bottom" -> candidates.asReversed()
                    "random" -> {
                        val first = candidates[randomSlot.coerceAtMost(candidates.lastIndex)]
                        listOf(first) + candidates.filter { it !== first }.shuffled()
                    }
                    else -> candidates
                }
                val picks = ordered.take(want)
                val bucket = chosenLists.getOrPut(typeKey) { mutableListOf() }
                for (picked in picks) {
                    bucket.add(picked.second.value)
                    groupConsumed.add(picked.first)
                }
                if (!chosenFields.containsKey(typeKey)) {
                    chosenFields[typeKey] = picks.first().second.value
                }
            }
            consumed[name] = groupConsumed
        }

        if (!anyFound) return null

        chosenFields["password"]?.let { pwd -> chosenFields["confirmpassword"] = pwd }
        chosenFields["email"]?.let { mail -> chosenFields["confirmemail"] = mail }
        chosenFields["phone"]?.let { tel -> chosenFields["confirmphone"] = tel }

        val fullName = chosenFields["fullname"]
        if (!fullName.isNullOrBlank()) {
            val parts = fullName.trim().split(Regex("\\s+"))
            if (!chosenFields.containsKey("firstname") && parts.isNotEmpty()) chosenFields["firstname"] = parts.first()
            if (!chosenFields.containsKey("lastname") && parts.size > 1) chosenFields["lastname"] = parts.drop(1).joinToString(" ")
            if (!chosenFields.containsKey("surname") && parts.size > 1) chosenFields["surname"] = parts.last()
        }

        return ActiveAutomationProfile(consumed, chosenFields, chosenLists)
    }

    // "+216", "+91", "+ 60": a bare dial code. It was sometimes stored as EMAIL/TEXT/OTP by the single-token guesser.
    private val DIAL_CODE = Regex("^\\+\\s*\\d{1,4}$")

    private val DOB_TYPES = setOf("dob", "dobday", "dobmonth", "dobyear")
    private val MONTH_NAME = Regex("^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?$", RegexOption.IGNORE_CASE)

    /**
     * Field type to use for this entry. The single-token guesser files bare numbers and dial codes under EMAIL/TEXT,
     * so: a "+<digits>" value is a country code; inside a date-of-birth group a bare number is the day, month or
     * year (judged by its size and by the group name); anything typed EMAIL without an "@" takes the group's type.
     */
    fun effectiveType(entry: VaultEntry, groupName: String = ""): String {
        val (key, ord) = splitOrdinal(entry.fieldType)
        val v = entry.value.trim()
        if (DIAL_CODE.matches(v) && key != "countrycode") return "countrycode"
        if (ord > 1) return key + ord          // "dob2" etc.: the person chose this pool on purpose
        // A group named "Dob2" holds the SECOND date of birth: its DOB entries belong to the dob2 pool
        if (groupName.isNotBlank()) {
            val (gBase, gOrd) = splitOrdinal(groupName)
            if (gOrd > 1 && gBase == key) return key + gOrd
        }
        val gname = groupName.lowercase()
        val ghint = if (groupName.isBlank()) "" else normalizeFieldKey(groupName)
        val misTyped = (key == "email" && !v.contains("@")) || key == "text"
        val dobish = key in DOB_TYPES || ghint in DOB_TYPES
        if (dobish && (misTyped || key in DOB_TYPES)) {
            val n = v.toIntOrNull()
            when {
                MONTH_NAME.matches(v) -> return "dobmonth"
                n != null && v.length == 4 && n in 1900..2100 -> return "dobyear"
                n != null && v.length <= 2 -> return when {
                    "month" in gname -> "dobmonth"
                    "year" in gname -> "dobyear"
                    key == "dobmonth" || key == "dobyear" -> key
                    n in 1..31 -> "dobday"
                    else -> key
                }
            }
        }
        if (key == "email" && !v.contains("@") && ghint.isNotEmpty() && ghint != "text" && ghint != "email" &&
            !ghint.startsWith("group") && !ghint.startsWith("form") && !ghint.startsWith("imported")) return ghint
        return key
    }

    private fun repairEntry(e: VaultEntry, groupName: String = ""): VaultEntry {
        val t = effectiveType(e, groupName)
        return if (t != slotKey(e.fieldType)) e.copy(fieldType = t) else e
    }

    /** "dob2" -> ("dob", 2); a plain type is ordinal 1. ("password2" has always meant confirm-password.) */
    fun splitOrdinal(raw: String): Pair<String, Int> {
        val t = raw.trim().lowercase()
        val m = Regex("^(.*[a-z_\\-\\s])([2-9])$").matchEntire(t) ?: return normalizeFieldKey(t) to 1
        val base = normalizeFieldKey(m.groupValues[1])
        val ord = m.groupValues[2].toInt()
        if (base == "password" && ord == 2) return "confirmpassword" to 1
        return base to ord
    }

    /** Key of a data pool: the base type, plus the ordinal from the 2nd field of that type on ("dob", "dob2", "dob3"). */
    fun slotKey(raw: String): String {
        val (b, o) = splitOrdinal(raw)
        return if (o > 1) b + o else b
    }

    fun normalizeFieldKey(raw: String): String {
        var clean = raw.trim().lowercase()
        clean = clean.replace(Regex("\\b(input|field|box|form|text|number)\\b"), "")
        clean = clean.replace(Regex("\\d+"), "")
        clean = clean.replace(Regex("[_\\-\\s]+"), "")
        
        return when {
            clean in listOf("email", "emailaddress", "mail", "usermail") -> "email"
            clean in listOf("confirmemail", "retypeemail", "repeatemail", "verifyemail") -> "confirmemail"
            clean in listOf("confirmpassword", "retypepassword", "repeatpassword", "verifypassword", "password2", "pass2") -> "confirmpassword"
            clean in listOf("password", "pwd", "pass", "passcode", "secret") -> "password"
            clean in listOf("confirmphone", "retypephone", "repeatphone") -> "confirmphone"
            clean in listOf("phone", "phonenumber", "mobile", "mobilenumber", "tel", "telephone", "contact", "cell") -> "phone"
            clean in listOf("firstname", "fname", "givenname", "forename") -> "firstname"
            clean in listOf("lastname", "lname", "surname", "familyname") -> "lastname"
            clean in listOf("middlename", "mname") -> "middlename"
            clean in listOf("fullname", "name", "yourname", "completename") -> "fullname"
            clean in listOf("nickname", "alias", "displayname") -> "nickname"
            clean in listOf("username", "userid", "user", "login", "handle") -> "username"
            clean in listOf("message", "yourmessage", "comments", "comment", "body", "description", "bio", "inquiry") -> "message"
            clean in listOf("subject", "title", "topic", "reason") -> "subject"
            clean in listOf("birthyear", "yearofbirth", "dobyear", "bdayyear", "yearbirth") -> "dobyear"
            clean in listOf("birthmonth", "monthofbirth", "dobmonth", "bdaymonth") -> "dobmonth"
            clean in listOf("dayofbirth", "dobday", "bdayday") -> "dobday"
            clean in listOf("dob", "dateofbirth", "birthdate", "birthday", "bday", "date") -> "dob"
            clean in listOf("gender", "sex") -> "gender"
            clean in listOf("address", "street", "streetaddress", "addr", "house") -> "address"
            clean in listOf("city", "town", "locality") -> "city"
            clean in listOf("state", "province", "region") -> "state"
            clean in listOf("zip", "zipcode", "postal", "postalcode", "pincode", "pin") -> "zip"
            clean in listOf("country", "nation") -> "country"
            clean in listOf("countrycode", "countrycallingcode", "callingcode", "dialcode", "diallingcode", "isdcode", "phonecode") -> "countrycode"
            clean in listOf("company", "companyname", "organization", "organisation", "organizationname", "organisationname", "business", "businessname", "employer", "firm") -> "company"
            clean in listOf("website", "web", "site", "url", "homepage", "weburl", "websiteurl", "companywebsite", "link") -> "website"
            clean in listOf("jobtitle", "designation", "position", "role") -> "jobtitle"
            clean in listOf("otp", "code", "verificationcode") -> "otp"
            else -> clean.ifBlank { "text" }
        }
    }

    private fun parseEntries(rawText: String, groupHint: String = ""): List<VaultEntry> {
        val result = mutableListOf<VaultEntry>()
        val hintedType = normalizeFieldKey(groupHint)
        val hasSpecificGroupHint = hintedType != "text" && !hintedType.startsWith("group") && !hintedType.startsWith("form") && !hintedType.startsWith("imported")

        rawText.lines().map { it.trim() }.filter { it.isNotEmpty() }.forEach { line ->
            val colonParts = line.split(":", limit = 2)
            if (colonParts.size == 2 && colonParts[0].trim().length in 2..25 && !colonParts[0].contains("@")) {
                val key = slotKey(colonParts[0])
                val value = colonParts[1].trim()
                if (value.isNotEmpty()) {
                    result.add(VaultEntry(fieldType = key, value = value, used = false))
                    return@forEach
                }
            }

            if (line.contains("|") && line.count { it == '|' } in 1..4) {
                val tokens = line.split("|").map { it.trim() }.filter { it.isNotEmpty() }
                tokens.forEach { token ->
                    val guessed = SmartParser.classifySingleToken(token)
                    result.add(VaultEntry(fieldType = guessed, value = token, used = false))
                }
                return@forEach
            }

            val detectedType = if (hasSpecificGroupHint) hintedType else SmartParser.classifySingleToken(line)
            result.add(VaultEntry(fieldType = detectedType, value = line, used = false))
        }
        return result.map { repairEntry(it, groupHint) }
    }

    private fun save() {
        val json = JSONArray()
        groups.value.forEach { group ->
            val groupJson = JSONObject()
            groupJson.put("name", group.name)
            groupJson.put("pinned", group.pinned)
            groupJson.put("type", group.type.name)
            val entriesJson = JSONArray()
            group.entries.forEach { entry ->
                val entryJson = JSONObject()
                entryJson.put("fieldType", entry.fieldType)
                entryJson.put("value", entry.value)
                entryJson.put("used", entry.used)
                entriesJson.put(entryJson)
            }
            groupJson.put("entries", entriesJson)
            json.put(groupJson)
        }
        prefs?.edit()?.putString(KEY_GROUPS, json.toString())?.apply()
    }

    private fun load(): List<VaultGroup> {
        val raw = prefs?.getString(KEY_GROUPS, null) ?: return emptyList()
        return try {
            val json = JSONArray(raw)
            (0 until json.length()).map { i ->
                val groupJson = json.getJSONObject(i)
                val entriesJson = groupJson.getJSONArray("entries")
                val entries = (0 until entriesJson.length()).map { j ->
                    val entryJson = entriesJson.getJSONObject(j)
                    VaultEntry(
                        fieldType = entryJson.getString("fieldType"),
                        value = entryJson.getString("value"),
                        used = entryJson.optBoolean("used", false),
                    )
                }
                val gName = groupJson.getString("name")
                VaultGroup(
                    name = gName,
                    entries = entries.map { repairEntry(it, gName) },
                    pinned = groupJson.optBoolean("pinned", false),
                    type = try { DataGroupType.valueOf(groupJson.optString("type", "RECURRING")) } catch (_: Exception) { DataGroupType.RECURRING }
                )
            }
        } catch (e: Exception) {
            emptyList()
        }
    }
}