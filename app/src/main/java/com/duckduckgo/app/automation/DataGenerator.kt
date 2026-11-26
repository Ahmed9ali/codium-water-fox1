package com.duckduckgo.app.automation

import java.security.SecureRandom
import java.util.Calendar

/**
 * Random but realistic test data for one data group. Pure Kotlin, no Android classes.
 *
 *   DataGenerator.generate("email", 20)                   -> 20 different e-mail addresses
 *   DataGenerator.generate("dob", 5, "18", "40")           -> 5 dates of birth, age 18..40, as dd/MM/yyyy
 *   DataGenerator.generate("phone", 10, "10")              -> 10 phone numbers of 10 digits
 *   DataGenerator.generate("dob2", 5)                      -> same as "dob" (the 2 only says which pool the entries go to)
 *
 * Every value in one call is unique. [paramSpecs] tells a screen which one or two options a type understands.
 */
object DataGenerator {
    data class GenType(val key: String, val label: String)
    data class ParamSpec(val label: String, val default: String)

    val TYPES: List<GenType> = listOf(
        GenType("email", "Email"),
        GenType("phone", "Phone number"),
        GenType("password", "Password"),
        GenType("fullname", "Full name"),
        GenType("firstname", "First name"),
        GenType("lastname", "Last name"),
        GenType("username", "Username"),
        GenType("countrycode", "Country code"),
        GenType("country", "Country"),
        GenType("dob", "Date of birth"),
        GenType("dobday", "Birth day"),
        GenType("dobmonth", "Birth month"),
        GenType("dobyear", "Birth year"),
        GenType("company", "Company"),
        GenType("website", "Website"),
        GenType("jobtitle", "Job title"),
        GenType("address", "Address"),
        GenType("city", "City"),
        GenType("zip", "Zip / postal code"),
        GenType("otp", "Number code"),
        GenType("text", "Random words"),
    )

    /** Options of a type: up to two, each with a label and a default. */
    fun paramSpecs(type: String): List<ParamSpec> = when (baseOf(type)) {
        "email" -> listOf(ParamSpec("Domains (comma separated)", "gmail.com,outlook.com,yahoo.com"))
        "username" -> listOf(ParamSpec("Suffix digits", "3"))
        "phone" -> listOf(ParamSpec("Digits", "10"), ParamSpec("Starts with (optional)", ""))
        "password" -> listOf(ParamSpec("Length", "12"), ParamSpec("Symbols (yes / no)", "yes"))
        "countrycode" -> listOf(ParamSpec("Format (+60 / 60 / name)", "+"), ParamSpec("Only these (e.g. 60,91,1)", ""))
        "dob" -> listOf(ParamSpec("Youngest age", "18"), ParamSpec("Oldest age", "40"))
        "dobyear" -> listOf(ParamSpec("Youngest age", "18"), ParamSpec("Oldest age", "40"))
        "zip" -> listOf(ParamSpec("Digits", "6"))
        "otp" -> listOf(ParamSpec("Digits", "6"))
        "website" -> listOf(ParamSpec("Ending", ".com"))
        else -> emptyList()
    }

    /** Type to start from for a group name: "Dob2" -> "dob2", "Company Website" -> "website", unknown -> "text". */
    fun typeForGroup(groupName: String): String {
        val slot = VaultRepository.slotKey(groupName)
        val base = VaultRepository.splitOrdinal(groupName).first
        return if (TYPES.any { it.key == base }) slot else "text"
    }

    private fun baseOf(type: String): String = VaultRepository.splitOrdinal(type).first

    fun generate(type: String, count: Int, p1: String = "", p2: String = ""): List<String> {
        val n = count.coerceIn(1, 500)
        val base = baseOf(type)
        val specs = paramSpecs(type)
        val a = p1.trim().ifEmpty { specs.getOrNull(0)?.default.orEmpty() }
        val b = if (p2.isBlank()) specs.getOrNull(1)?.default.orEmpty() else p2.trim()
        val seen = LinkedHashSet<String>()
        var guard = 0
        // some types have few possible values (months, countries): stop when they run out
        while (seen.size < n && guard++ < n * 60) seen.add(one(base, a, b))
        return seen.toList()
    }

    // ---- one value ----------------------------------------------------------------------------------------------

    private val rnd = SecureRandom()
    private fun <T> pick(l: List<T>): T = l[rnd.nextInt(l.size)]
    private fun int(from: Int, toInclusive: Int): Int = from + rnd.nextInt(toInclusive - from + 1)
    private fun digits(len: Int, firstNonZero: Boolean = true): String {
        val sb = StringBuilder()
        for (i in 0 until len) sb.append(if (i == 0 && firstNonZero) int(1, 9) else int(0, 9))
        return sb.toString()
    }
    private fun cap(s: String) = s.replaceFirstChar { it.uppercase() }

    private fun one(base: String, a: String, b: String): String = when (base) {
        "email" -> email(a)
        "phone" -> phone(a.toIntOrNull() ?: 10, b)
        "password" -> password(a.toIntOrNull() ?: 12, !b.equals("no", true) && !b.equals("false", true))
        "fullname" -> cap(pick(FIRST)) + " " + cap(pick(LAST))
        "firstname" -> cap(pick(FIRST))
        "lastname" -> cap(pick(LAST))
        "username" -> username(a.toIntOrNull() ?: 3)
        "countrycode" -> countryCode(a, b)
        "country" -> pick(COUNTRIES).first
        "dob" -> dob(a.toIntOrNull() ?: 18, b.toIntOrNull() ?: 40)
        "dobday" -> int(1, 28).toString()
        "dobmonth" -> int(1, 12).toString()
        "dobyear" -> (Calendar.getInstance().get(Calendar.YEAR) - int(a.toIntOrNull() ?: 18, b.toIntOrNull() ?: 40)).toString()
        "company" -> pick(COMPANY_A) + " " + pick(COMPANY_B)
        "website" -> pick(WORDS) + pick(WORDS).take(4) + (a.ifBlank { ".com" }.let { if (it.startsWith(".")) it else ".$it" })
        "jobtitle" -> pick(JOBS)
        "address" -> "${int(1, 9999)} ${cap(pick(WORDS))} ${pick(STREET)}"
        "city" -> pick(CITIES)
        "zip" -> digits(a.toIntOrNull() ?: 6)
        "otp" -> digits(a.toIntOrNull() ?: 6, firstNonZero = false)
        else -> pick(WORDS) + " " + pick(WORDS)
    }

    private fun email(domains: String): String {
        val doms = domains.split(",").map { it.trim().trimStart('@') }.filter { it.contains(".") }.ifEmpty { listOf("gmail.com") }
        val f = pick(FIRST); val l = pick(LAST)
        val local = when (int(0, 3)) {
            0 -> "$f.$l${int(1, 999)}"
            1 -> "$f$l${int(10, 99)}"
            2 -> "${f.first()}$l${int(100, 9999)}"
            else -> "${f}_${l}${int(1, 99)}"
        }
        return local.lowercase() + "@" + pick(doms)
    }

    private fun phone(len: Int, prefix: String): String {
        val p = prefix.filter { it.isDigit() }
        val total = len.coerceIn(5, 15)
        return if (p.length >= total) p.take(total) else p + digits(total - p.length, firstNonZero = p.isEmpty())
    }

    private const val PW_LOWER = "abcdefghijkmnopqrstuvwxyz"
    private const val PW_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"
    private const val PW_DIGIT = "23456789"
    private const val PW_SYMBOL = "!@#\$%&*?"
    private fun password(length: Int, symbols: Boolean): String {
        val len = length.coerceIn(6, 64)
        val groups = mutableListOf(PW_LOWER, PW_UPPER, PW_DIGIT)
        if (symbols) groups.add(PW_SYMBOL)
        val all = groups.joinToString("")
        // one of each kind first, so every site's "needs a digit / capital / symbol" rule is met
        val chars = groups.map { it[rnd.nextInt(it.length)] }.toMutableList()
        while (chars.size < len) chars.add(all[rnd.nextInt(all.length)])
        chars.shuffle(rnd)
        return chars.joinToString("")
    }

    private fun username(suffix: Int): String {
        val base = (pick(FIRST) + (if (rnd.nextBoolean()) "." else "_") + pick(LAST)).lowercase()
        return base + (if (suffix > 0) digits(suffix, firstNonZero = false) else "")
    }

    private fun countryCode(format: String, only: String): String {
        val allowed = only.split(",", " ").map { it.filter { c -> c.isDigit() } }.filter { it.isNotEmpty() }
        val pool = if (allowed.isEmpty()) COUNTRIES else COUNTRIES.filter { it.second in allowed }.ifEmpty { COUNTRIES }
        val (name, code) = pick(pool)
        return when {
            format.equals("name", true) -> name.lowercase()
            format.startsWith("+") || format.isBlank() -> "+$code"
            else -> code
        }
    }

    private fun dob(minAge: Int, maxAge: Int): String {
        val lo = minOf(minAge, maxAge).coerceIn(1, 100)
        val hi = maxOf(minAge, maxAge).coerceIn(lo, 110)
        val year = Calendar.getInstance().get(Calendar.YEAR) - int(lo, hi)
        val month = int(1, 12)
        val day = int(1, daysIn(month, year))
        return String.format(java.util.Locale.ROOT, "%02d/%02d/%04d", day, month, year)
    }
    private fun daysIn(month: Int, year: Int): Int = when (month) {
        2 -> if (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) 29 else 28
        4, 6, 9, 11 -> 30
        else -> 31
    }

    // ---- word lists -----------------------------------------------------------------------------------------------

    private val FIRST = listOf("james", "mary", "john", "patricia", "robert", "jennifer", "michael", "linda", "william", "elizabeth", "david", "susan", "richard", "jessica", "joseph", "sarah", "thomas", "karen", "daniel", "nancy", "matthew", "lisa", "anthony", "betty", "mark", "sandra", "paul", "ashley", "steven", "emily", "andrew", "donna", "kevin", "michelle", "brian", "carol", "george", "amanda", "edward", "melissa", "ryan", "deborah", "jacob", "laura", "eric", "helen", "arjun", "priya", "rahul", "anita", "ahmad", "siti", "wei", "mei", "omar", "fatima", "carlos", "sofia", "luca", "elena", "ivan", "olga", "kenji", "yuki", "noah", "emma")
    private val LAST = listOf("smith", "johnson", "williams", "brown", "jones", "garcia", "miller", "davis", "rodriguez", "martinez", "hernandez", "lopez", "gonzalez", "wilson", "anderson", "thomas", "taylor", "moore", "jackson", "martin", "lee", "perez", "thompson", "white", "harris", "sanchez", "clark", "ramirez", "lewis", "robinson", "walker", "young", "allen", "king", "wright", "scott", "torres", "nguyen", "hill", "flores", "green", "adams", "nelson", "baker", "hall", "rivera", "campbell", "mitchell", "carter", "roberts", "sharma", "patel", "singh", "kumar", "rahman", "tan", "lim", "wong", "chen", "khan", "ali", "ivanov", "rossi", "silva", "tanaka")
    private val COUNTRIES = listOf(
        "Malaysia" to "60", "India" to "91", "United States" to "1", "United Kingdom" to "44", "Canada" to "1", "Australia" to "61",
        "Singapore" to "65", "Indonesia" to "62", "Philippines" to "63", "Thailand" to "66", "Vietnam" to "84", "China" to "86",
        "Japan" to "81", "South Korea" to "82", "Pakistan" to "92", "Bangladesh" to "880", "Sri Lanka" to "94", "Nepal" to "977",
        "United Arab Emirates" to "971", "Saudi Arabia" to "966", "Qatar" to "974", "Kuwait" to "965", "Egypt" to "20", "Nigeria" to "234",
        "Kenya" to "254", "South Africa" to "27", "Tunisia" to "216", "Angola" to "244", "Morocco" to "212", "Turkey" to "90",
        "Germany" to "49", "France" to "33", "Italy" to "39", "Spain" to "34", "Netherlands" to "31", "Brazil" to "55", "Mexico" to "52",
        "Argentina" to "54", "Russia" to "7", "Ukraine" to "380", "Poland" to "48", "New Zealand" to "64", "Ireland" to "353",
    )
    private val COMPANY_A = listOf("Blue", "Red", "Green", "Silver", "Golden", "Bright", "Swift", "Nova", "Alpha", "Prime", "Urban", "Delta", "Orbit", "Pixel", "Solar", "North", "Summit", "Vertex", "Zen", "Atlas")
    private val COMPANY_B = listOf("Systems", "Solutions", "Labs", "Industries", "Trading", "Consulting", "Digital", "Media", "Logistics", "Networks", "Group", "Partners", "Works", "Tech", "Ventures", "Holdings")
    private val WORDS = listOf("river", "stone", "cloud", "forest", "harbor", "meadow", "falcon", "ember", "lotus", "maple", "orchid", "quartz", "raven", "summit", "tundra", "willow", "zephyr", "amber", "breeze", "canyon", "dune", "echo", "fjord", "glacier", "horizon", "island", "jungle", "kernel", "lagoon", "mist")
    private val STREET = listOf("Street", "Road", "Avenue", "Lane", "Drive", "Boulevard", "Court", "Way")
    private val CITIES = listOf("Kuala Lumpur", "Mumbai", "Delhi", "Bangalore", "Chennai", "Singapore", "Jakarta", "Manila", "Bangkok", "Hanoi", "Dubai", "Doha", "London", "Manchester", "New York", "Chicago", "Toronto", "Sydney", "Berlin", "Paris", "Madrid", "Rome", "Lagos", "Nairobi", "Cairo", "Tunis", "Istanbul", "Tokyo", "Seoul", "Karachi")
    private val JOBS = listOf("Software Engineer", "Project Manager", "Marketing Manager", "Sales Executive", "Accountant", "Designer", "Data Analyst", "Product Manager", "HR Specialist", "Operations Manager", "Consultant", "Customer Support Lead", "Business Analyst", "Teacher", "Research Scientist")
}
