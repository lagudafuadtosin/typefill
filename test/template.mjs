// The free template engine on its own, in Node: fields, toggles, dates, repeats, imports, and Pro parts showing as
// [Typefill Pro] and being named, since this build has no Pro
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctxGlobal = { console };
vm.createContext(ctxGlobal);
vm.runInContext(readFileSync("src/template.js", "utf8"), ctxGlobal, { filename: "src/template.js" });
const T = ctxGlobal.TFTemplate;

let failed = 0, n = 0;
const check = (name, got, want) => {
  n++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${String(n).padStart(2)}. ${ok ? "✔" : "✘ FAIL"} ${name}${ok ? "" : `\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`}`);
};
const run = (src, values = {}, ctx = {}, resolve) => T.render(T.parse(src, resolve), values, ctx);

check("text box", run("Hi {formtext: name=Name}!", { Name: "Sam" }), "Hi Sam!");
check("repeat a field", run("{formtext: name=First name}, yes {=First name}", { "First name": "Ada" }), "Ada, yes Ada");
check("dropdown fields", T.fields(T.parse("{formmenu: name=Size; default=M; S; L}"))[0].options, ["M", "S", "L"]);
check("toggle off", run("A{formtoggle: name=PS; default=no} B{endformtoggle}.", { PS: false }), "A.");
check("toggle on", run("A{formtoggle: name=PS} B{endformtoggle}.", { PS: true }), "A B.");
check("date", run("{time: YYYY-MM-DD; shift=+1D}", {}, { now: new Date(2026, 9, 31, 12) }), "2026-11-01");
check("date picker", run("{formdate: name=Due; format=Do MMMM}", { Due: "2026-12-25" }), "25th December");
check("import", run("A {import: /sig} B", {}, {}, (s) => (s === "/sig" ? "Sig" : null)), "A Sig B");
check("caret mark", T.splitCaret(run("ab{cursor}cd")), { text: "abcd", back: 2 });
check("escaped braces", run("\\{not a field\\}"), "{not a field}");
check("unknown commands kept", run("{shrug: x}"), "{shrug: x}");
check("plain repeat is free", T.proParts(T.parse("{formtext: name=Qty}{=Qty}")), []);
check("Pro parts named", T.proParts(T.parse("{if: 1}x{endif}{=1+1}{site: url}{key: tab}{lookup: sheet=s}")), ["if blocks", "formulas", "page data", "key steps", "sheet data"]);
check("Pro parts show as [Typefill Pro] without Pro", run("A {=Qty * 2} B"), "A [Typefill Pro] B");
check("fields inside an if still asked for", T.fields(T.parse("{if: X}{formtext: name=One}{else}{formtext: name=Two}{endif}")).map((f) => f.name), ["One", "Two"]);

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
