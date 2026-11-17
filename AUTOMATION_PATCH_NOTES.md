# SwiftBrowser automation reliability patch (v20 follow-up)

## Changes in this source package

1. `app/src/main/assets/automation/automation_recorder.js`
   - Recorder bumped to v19.
   - Captured events are always placed in the recorder outbox and are drained by the Android `AutomationEngine` polling path. The page no longer treats the mere presence of `window.AutomationBridge` as proof that Android received the callback.
   - The on-page status now says `Captured — saving…`; the existing native acknowledgement changes it to `Recorded #N` or `Not recorded: reason`.
   - Field classification uses a nearest field wrapper or nearest popup/dialog, instead of concatenating text from five arbitrary ancestors. This avoids unrelated form controls inheriting the same label.
   - Added `countryCode`, `currency`, and DOB subfield classification (`dobYear`, `dobMonth`, `dobDay`).
   - Remembers the most recently opened DOB/country/currency picker briefly so portalled menu options can inherit the correct field context.
   - Highlights only the current target and restores the previous target's outline.

2. `app/src/main/assets/automation/automation_scanner.js`
   - Added explicit country calling-code and currency recognition.
   - Added separate autocomplete mappings for birth day/month/year.

3. `app/src/main/java/com/duckduckgo/app/automation/RecordedStep.kt`
   - Added canonical labels/types for Currency, Birth Year, Birth Month and Birth Day.

4. `app/src/main/java/com/duckduckgo/app/automation/AutomationEngine.kt`
   - Increased recorder outbox drain frequency from 400 ms to 150 ms to reduce the chance that a fast page navigation replaces the document before the native recorder receives the queued tap.

## Validation performed

- `node --check` passed for both modified JavaScript files.
- Full Android/Kotlin Gradle compilation was attempted, but the environment could not download Gradle 9.8 because external DNS/network access was unavailable (`UnknownHostException: services.gradle.org`). Therefore this package is not represented as a verified Android build.
- No live-device test was possible in this environment.

## Suggested device test

1. Start a fresh recording.
2. Open the currency dropdown and select MYR.
3. Confirm the panel count increments and the acknowledgement says `Recorded #1: Currency Input`.
4. Open a country dropdown and select a country.
5. Open DOB, choose year, then month/day.
6. Tap a normal text field and a back arrow.
7. Confirm each tap adds exactly one step and only the currently tapped element is outlined.

If an event is rejected, the red acknowledgement should now show the native reason rather than leaving a misleading `Grabbed` toast.


## v20 follow-up fixes applied after reviewing device captures

1. `automation_recorder.js`
   - Removed global field-context contamination: remembered picker context now applies only to option-like elements inside a popup.
   - Recognizes FydeOS `[data-type="fydeos_select"]` / `.choose_value` controls and derives DOB subfield context from nearby captions.
   - Recognizes Huawei `#selectedCountry` / `.hwid-selectedCountryName` and promotes the display span to its clickable owner when available.
   - Recognizes phone country-code comboboxes showing `+NN` when they are in a phone field group or beside a telephone input.
   - Skips popup shells (`listbox`, `menu`, `dialog`, popover wrappers) as capture targets while still allowing their options to be captured.
   - Uses a highlight generation token so an older timeout cannot clear a newer highlight on the same element.
   - Recorder version bumped to v20.
2. `automation_scanner.js`
   - Adds the FydeOS and Huawei custom controls to the field scan selector.
   - Adds nearby field-caption context for custom controls and explicit DOB year/month/day, country, and country-code classification.

Validation: `node --check` passed for both JavaScript files. These changes still require real-device testing on the supplied target sites; no Android build or live-device test is claimed.
