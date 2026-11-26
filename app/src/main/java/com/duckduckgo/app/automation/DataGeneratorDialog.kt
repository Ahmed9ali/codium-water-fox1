package com.duckduckgo.app.automation

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog

/**
 * "Generate data" dialog for one recurring group. Uses only compose foundation + ui (no Material), so it compiles
 * whichever Material version the app uses. The colours match the dark data screens.
 *
 * Use (in the screen that shows one group, next to "+ Add Data to '...'"):
 *
 *     var showGenerator by remember { mutableStateOf(false) }
 *     // a button anywhere in the screen:   Button(onClick = { showGenerator = true }) { Text("Generate data") }
 *     if (showGenerator) {
 *         DataGeneratorDialog(groupName = group.name, onDismiss = { showGenerator = false })
 *     }
 *
 * It adds the generated entries to the group (type chosen in the dialog, "dob2" for a Dob2 group by default).
 */
@Composable
fun DataGeneratorDialog(
    groupName: String,
    onDismiss: () -> Unit,
    onGenerated: (Int) -> Unit = {},
) {
    val bg = Color(0xFF2B2B2B)
    val card = Color(0xFF3A3A3A)
    val accent = Color(0xFF6D8DF7)
    val textColor = Color(0xFFEAEAEA)
    val muted = Color(0xFF9A9A9A)

    var type by remember { mutableStateOf(DataGenerator.typeForGroup(groupName)) }
    var countText by remember { mutableStateOf("10") }
    var p1 by remember { mutableStateOf("") }
    var p2 by remember { mutableStateOf("") }
    val specs = DataGenerator.paramSpecs(type)
    val baseOfType = VaultRepository.splitOrdinal(type).first

    Dialog(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(bg, RoundedCornerShape(20.dp))
                .padding(20.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            BasicText("Generate data for '$groupName'", style = TextStyle(color = textColor, fontSize = 18.sp, fontWeight = FontWeight.SemiBold))
            BasicText("Type of data", style = TextStyle(color = muted, fontSize = 12.sp))
            Row(modifier = Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                DataGenerator.TYPES.forEach { t ->
                    val selected = t.key == baseOfType
                    Box(
                        modifier = Modifier
                            .background(if (selected) accent else card, RoundedCornerShape(50))
                            .clickable {
                                // keep the pool number of the group ("dob2") when the base type stays the same
                                val ord = VaultRepository.splitOrdinal(type).second
                                type = if (ord > 1) t.key + ord else t.key
                                p1 = ""; p2 = ""
                            }
                            .padding(horizontal = 14.dp, vertical = 8.dp),
                    ) { BasicText(t.label, style = TextStyle(color = if (selected) Color.White else textColor, fontSize = 14.sp)) }
                }
            }

            LabeledField("How many", countText, { countText = it.filter(Char::isDigit).take(3) }, "10", card, textColor, muted, accent, numeric = true)
            specs.getOrNull(0)?.let { sp -> LabeledField(sp.label, p1, { p1 = it }, sp.default, card, textColor, muted, accent) }
            specs.getOrNull(1)?.let { sp -> LabeledField(sp.label, p2, { p2 = it }, sp.default, card, textColor, muted, accent) }

            val count = (countText.toIntOrNull() ?: 0).coerceIn(0, 500)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                Box(
                    modifier = Modifier.weight(1f).border(1.dp, accent, RoundedCornerShape(14.dp)).clickable { onDismiss() }.padding(vertical = 12.dp),
                    contentAlignment = Alignment.Center,
                ) { BasicText("Cancel", style = TextStyle(color = accent, fontSize = 16.sp)) }
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .background(if (count > 0) accent else card, RoundedCornerShape(14.dp))
                        .clickable(enabled = count > 0) {
                            val values = DataGenerator.generate(type, count, p1, p2)
                            VaultRepository.addGeneratedEntries(groupName, type, values)
                            onGenerated(values.size)
                            onDismiss()
                        }
                        .padding(vertical = 12.dp),
                    contentAlignment = Alignment.Center,
                ) { BasicText("Generate $count", style = TextStyle(color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)) }
            }
        }
    }
}

@Composable
private fun LabeledField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    hint: String,
    card: Color,
    textColor: Color,
    muted: Color,
    accent: Color,
    numeric: Boolean = false,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        BasicText(label, style = TextStyle(color = muted, fontSize = 12.sp))
        Box(modifier = Modifier.fillMaxWidth().background(card, RoundedCornerShape(12.dp)).padding(horizontal = 14.dp, vertical = 12.dp)) {
            if (value.isEmpty()) BasicText(hint, style = TextStyle(color = muted.copy(alpha = 0.6f), fontSize = 15.sp))
            BasicTextField(
                value = value,
                onValueChange = onChange,
                singleLine = true,
                textStyle = TextStyle(color = textColor, fontSize = 15.sp),
                cursorBrush = SolidColor(accent),
                keyboardOptions = KeyboardOptions(keyboardType = if (numeric) KeyboardType.Number else KeyboardType.Text),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
