package org.randprotocol.wallet.util;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import javax.xml.parsers.DocumentBuilderFactory;

/**
 * The English a {@link L10n} call carries is the English its resource holds: on the JVM (and in a
 * test) the call's literal is what is shown, on a device the resource is, and the two must say the
 * same thing. Also: every R.string / R.plurals the code names exists in res/values/strings.xml.
 */
public class StringsParityTest {
    private static final String LIT = "\"(?:[^\"\\\\]|\\\\.)*\"";
    private static final String SEQ = "((?:" + LIT + "\\s*\\+\\s*)*" + LIT + ")";
    private static final Pattern T = Pattern.compile(
            "(?:L10n\\.t|\\be|\\bp)\\(\\s*(?:" + LIT + "\\s*,\\s*)?R\\.string\\.(\\w+)\\s*,\\s*(?:" + SEQ + "|([A-Z_][A-Z0-9_]*))\\s*[,)]");
    private static final Pattern PLURAL = Pattern.compile(
            "L10n\\.plural\\(\\s*R\\.plurals\\.(\\w+)\\s*,[^,]+,\\s*" + SEQ + "\\s*,\\s*" + SEQ);
    private static final Pattern CONST = Pattern.compile("static final String (\\w+)\\s*=\\s*" + SEQ + "\\s*;");
    private static final Pattern REF = Pattern.compile("R\\.(string|plurals)\\.(\\w+)");
    private static final Pattern XML_REF = Pattern.compile("@string/(\\w+)");

    private static File main() {
        File m = new File("src/main");
        if (!m.isDirectory()) m = new File("app/src/main");
        assertTrue("run from the android/ or android/app directory", m.isDirectory());
        return m;
    }

    /** An Android string resource's text as the app reads it (outer quotes and backslash escapes resolved). */
    static String resource(String raw) {
        String t = raw;
        if (t.length() >= 2 && t.startsWith("\"") && t.endsWith("\"")) t = t.substring(1, t.length() - 1);
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if (c == '\\' && i + 1 < t.length()) {
                char n = t.charAt(++i);
                if (n == 'n') out.append('\n');
                else if (n == 't') out.append('\t');
                else if (n == 'u' && i + 4 < t.length()) {
                    out.append((char) Integer.parseInt(t.substring(i + 1, i + 5), 16));
                    i += 4;
                } else out.append(n);
            } else out.append(c);
        }
        return out.toString();
    }

    /** A Java source's string literal (or {@code "a" + "b"} run of them) as the program sees it. */
    static String java(String seq) {
        Matcher m = Pattern.compile(LIT).matcher(seq);
        StringBuilder raw = new StringBuilder();
        while (m.find()) raw.append(m.group().substring(1, m.group().length() - 1));
        StringBuilder out = new StringBuilder();
        String t = raw.toString();
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if (c == '\\' && i + 1 < t.length()) {
                char n = t.charAt(++i);
                if (n == 'n') out.append('\n');
                else if (n == 't') out.append('\t');
                else if (n == 'u') {
                    out.append((char) Integer.parseInt(t.substring(i + 1, i + 5), 16));
                    i += 4;
                } else out.append(n);
            } else out.append(c);
        }
        return out.toString();
    }

    @Test
    public void everyFallbackIsItsResourcesEnglish() throws Exception {
        File main = main();
        Map<String, String> strings = new HashMap<>();
        Map<String, Map<String, String>> plurals = new HashMap<>();
        org.w3c.dom.Document doc = DocumentBuilderFactory.newInstance().newDocumentBuilder()
                .parse(new File(main, "res/values/strings.xml"));
        NodeList ss = doc.getElementsByTagName("string");
        for (int i = 0; i < ss.getLength(); i++) {
            Element e = (Element) ss.item(i);
            strings.put(e.getAttribute("name"), resource(e.getTextContent()));
        }
        NodeList ps = doc.getElementsByTagName("plurals");
        for (int i = 0; i < ps.getLength(); i++) {
            Element e = (Element) ps.item(i);
            Map<String, String> q = new HashMap<>();
            NodeList items = e.getElementsByTagName("item");
            for (int j = 0; j < items.getLength(); j++) {
                Element it = (Element) items.item(j);
                q.put(it.getAttribute("quantity"), resource(it.getTextContent()));
            }
            plurals.put(e.getAttribute("name"), q);
        }

        List<String> problems = new ArrayList<>();
        int checked = 0;
        List<Path> sources;
        try (Stream<Path> w = Files.walk(new File(main, "java").toPath())) {
            sources = w.filter(p -> p.toString().endsWith(".java")).toList();
        }
        for (Path f : sources) {
            String src = new String(Files.readAllBytes(f), StandardCharsets.UTF_8);
            String file = f.getFileName().toString();
            Map<String, String> consts = new HashMap<>();
            Matcher c = CONST.matcher(src);
            while (c.find()) consts.put(c.group(1), java(c.group(2)));
            Matcher r = REF.matcher(src);
            while (r.find()) {
                boolean have = r.group(1).equals("string") ? strings.containsKey(r.group(2)) : plurals.containsKey(r.group(2));
                if (!have) problems.add(file + ": no resource R." + r.group(1) + "." + r.group(2));
            }
            Matcher t = T.matcher(src);
            while (t.find()) {
                String id = t.group(1);
                String english = t.group(2) != null ? java(t.group(2)) : consts.get(t.group(3));
                if (english == null) continue; // a constant from another class
                checked++;
                if (!english.equals(strings.get(id))) {
                    problems.add(file + ": R.string." + id + "\n  resource: " + strings.get(id) + "\n  code:     " + english);
                }
            }
            Matcher p = PLURAL.matcher(src);
            while (p.find()) {
                Map<String, String> q = plurals.get(p.group(1));
                if (q == null) continue;
                checked++;
                if (!java(p.group(2)).equals(q.get("one")) || !java(p.group(3)).equals(q.get("other"))) {
                    problems.add(file + ": R.plurals." + p.group(1) + " one/other differ from the code's English");
                }
            }
        }
        try (Stream<Path> w = Files.walk(new File(main, "res").toPath())) {
            for (Path f : w.filter(x -> x.toString().endsWith(".xml")).toList()) {
                Matcher m = XML_REF.matcher(new String(Files.readAllBytes(f), StandardCharsets.UTF_8));
                while (m.find()) if (!strings.containsKey(m.group(1))) problems.add(f.getFileName() + ": no @string/" + m.group(1));
            }
        }
        assertTrue("the scan found no L10n calls; has the pattern drifted?", checked > 100);
        assertEquals(String.join("\n", problems), 0, problems.size());
    }
}
