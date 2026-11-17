using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace StudioEX.Bridge.Net
{
    /// <summary>
    /// Minimal JSON reader/writer. .NET 3.5 has no built-in JSON and we avoid shipping extra DLLs.
    /// Parse yields Dictionary&lt;string,object&gt;, List&lt;object&gt;, double, string, bool, null.
    /// </summary>
    public static class Json
    {
        // ---------------- Serialize ----------------
        public static string Serialize(object value)
        {
            var sb = new StringBuilder(256);
            Write(sb, value);
            return sb.ToString();
        }

        private static void Write(StringBuilder sb, object v)
        {
            switch (v)
            {
                case null: sb.Append("null"); return;
                case string s: WriteString(sb, s); return;
                case bool b: sb.Append(b ? "true" : "false"); return;
                case float f: WriteNumber(sb, f); return;
                case double d: WriteNumber(sb, d); return;
                case int i: sb.Append(i.ToString(CultureInfo.InvariantCulture)); return;
                case long l: sb.Append(l.ToString(CultureInfo.InvariantCulture)); return;
                case uint ui: sb.Append(ui.ToString(CultureInfo.InvariantCulture)); return;
                case short sh: sb.Append(sh.ToString(CultureInfo.InvariantCulture)); return;
                case byte by: sb.Append(by.ToString(CultureInfo.InvariantCulture)); return;
                case Enum e: WriteString(sb, e.ToString()); return;
                case IDictionary dict:
                {
                    sb.Append('{');
                    bool first = true;
                    foreach (DictionaryEntry kv in dict)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        WriteString(sb, Convert.ToString(kv.Key, CultureInfo.InvariantCulture));
                        sb.Append(':');
                        Write(sb, kv.Value);
                    }
                    sb.Append('}');
                    return;
                }
                case IEnumerable list:
                {
                    sb.Append('[');
                    bool first = true;
                    foreach (var item in list)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        Write(sb, item);
                    }
                    sb.Append(']');
                    return;
                }
                default:
                    WriteString(sb, v.ToString());
                    return;
            }
        }

        private static void WriteNumber(StringBuilder sb, double d)
        {
            if (double.IsNaN(d)) { sb.Append("null"); return; }
            if (double.IsPositiveInfinity(d)) { sb.Append("1e999"); return; }
            if (double.IsNegativeInfinity(d)) { sb.Append("-1e999"); return; }
            sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
        }

        private static void WriteNumber(StringBuilder sb, float f)
        {
            // Floats round-trip exactly through double; "R" on the double keeps every bit.
            WriteNumber(sb, (double)f);
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        // ---------------- Parse ----------------
        public static object Parse(string json)
        {
            int i = 0;
            _depth = 0;
            var v = ParseValue(json, ref i);
            SkipWs(json, ref i);
            if (i != json.Length) throw new FormatException("Trailing characters in JSON at " + i);
            return v;
        }

        private static void SkipWs(string s, ref int i)
        {
            while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
        }

        [ThreadStatic] private static int _depth;
        private const int MaxDepth = 128; // deep nesting would overflow the stack and kill the game

        private static object ParseValue(string s, ref int i)
        {
            SkipWs(s, ref i);
            if (i >= s.Length) throw new FormatException("Unexpected end of JSON");
            char c = s[i];
            switch (c)
            {
                case '{':
                case '[':
                    if (++_depth > MaxDepth) throw new FormatException("JSON nested too deeply");
                    try { return c == '{' ? (object)ParseObject(s, ref i) : ParseArray(s, ref i); }
                    finally { _depth--; }
                case '"': return ParseString(s, ref i);
                case 't': Expect(s, ref i, "true"); return true;
                case 'f': Expect(s, ref i, "false"); return false;
                case 'n': Expect(s, ref i, "null"); return null;
                default: return ParseNumber(s, ref i);
            }
        }

        private static void Expect(string s, ref int i, string word)
        {
            if (string.CompareOrdinal(s, i, word, 0, word.Length) != 0)
                throw new FormatException("Expected '" + word + "' at " + i);
            i += word.Length;
        }

        private static Dictionary<string, object> ParseObject(string s, ref int i)
        {
            var d = new Dictionary<string, object>();
            i++; // {
            SkipWs(s, ref i);
            if (i < s.Length && s[i] == '}') { i++; return d; }
            while (true)
            {
                SkipWs(s, ref i);
                string key = ParseString(s, ref i);
                SkipWs(s, ref i);
                if (i >= s.Length || s[i] != ':') throw new FormatException("Expected ':' at " + i);
                i++;
                d[key] = ParseValue(s, ref i);
                SkipWs(s, ref i);
                if (i >= s.Length) throw new FormatException("Unterminated object");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == '}') { i++; return d; }
                throw new FormatException("Expected ',' or '}' at " + i);
            }
        }

        private static List<object> ParseArray(string s, ref int i)
        {
            var l = new List<object>();
            i++; // [
            SkipWs(s, ref i);
            if (i < s.Length && s[i] == ']') { i++; return l; }
            while (true)
            {
                l.Add(ParseValue(s, ref i));
                SkipWs(s, ref i);
                if (i >= s.Length) throw new FormatException("Unterminated array");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == ']') { i++; return l; }
                throw new FormatException("Expected ',' or ']' at " + i);
            }
        }

        private static string ParseString(string s, ref int i)
        {
            if (s[i] != '"') throw new FormatException("Expected string at " + i);
            i++;
            var sb = new StringBuilder();
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) break;
                char e = s[i++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        sb.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        i += 4;
                        break;
                    default: sb.Append(e); break;
                }
            }
            throw new FormatException("Unterminated string");
        }

        private static double ParseNumber(string s, ref int i)
        {
            int start = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            string num = s.Substring(start, i - start);
            if (num.Length == 0) throw new FormatException("Unexpected character '" + s[start] + "' at " + start);
            try { return double.Parse(num, NumberStyles.Float, CultureInfo.InvariantCulture); }
            catch (OverflowException) { return num.StartsWith("-") ? double.NegativeInfinity : double.PositiveInfinity; } // we emit ±1e999 for ±Infinity
        }

        // ---------------- Arg helpers ----------------
        public static double GetDouble(this Dictionary<string, object> d, string key, double def = 0)
        {
            if (d != null && d.TryGetValue(key, out var v) && v != null) return Convert.ToDouble(v, CultureInfo.InvariantCulture);
            return def;
        }

        public static float GetFloat(this Dictionary<string, object> d, string key, float def = 0f)
            => (float)d.GetDouble(key, def);

        public static int GetInt(this Dictionary<string, object> d, string key, int def = 0)
        {
            if (d != null && d.TryGetValue(key, out var v) && v != null) return Convert.ToInt32(v, CultureInfo.InvariantCulture);
            return def;
        }

        public static string GetString(this Dictionary<string, object> d, string key, string def = null)
        {
            if (d != null && d.TryGetValue(key, out var v) && v != null) return v as string ?? Convert.ToString(v, CultureInfo.InvariantCulture);
            return def;
        }

        public static bool GetBool(this Dictionary<string, object> d, string key, bool def = false)
        {
            if (d != null && d.TryGetValue(key, out var v) && v is bool b) return b;
            return def;
        }

        public static bool Has(this Dictionary<string, object> d, string key)
            => d != null && d.ContainsKey(key) && d[key] != null;

        public static List<object> GetList(this Dictionary<string, object> d, string key)
        {
            if (d != null && d.TryGetValue(key, out var v)) return v as List<object> ?? new List<object>();
            return new List<object>();
        }

        public static Dictionary<string, object> GetObject(this Dictionary<string, object> d, string key)
        {
            if (d != null && d.TryGetValue(key, out var v)) return v as Dictionary<string, object>;
            return null;
        }
    }
}
