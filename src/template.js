// Snippet templates: text with {commands} in it, the same shape Text Blaze uses so snippets can move across.
//   {time: YYYY-MM-DD; shift=+1D}   {clipboard}   {cursor}
//   {formtext: name=First name; default=Sam}   {formparagraph: name=Note}
//   {formmenu: name=Size; default=M; S; L}   {formtoggle: name=PS}...{endformtoggle}
//   {formdate: name=Due; format=D MMMM YYYY; default=+7D}
//   {=First name} repeats what was typed in that field.   {import: /sig} puts another snippet in.
// A backslash before { or } or ; keeps it as a plain character.
// A formatted snippet is HTML with the same commands in its text. Anything typed into a field is escaped there.
//
// Typefill Pro adds parts this file reads but doesn't work out: {if: ...}{else}{endif} blocks, {=formulas}, {site: ...},
// {lookup: ...}, dropdowns from a sheet, and {key: ...} / {wait: ...} steps. Pro registers how to work them out with
// extend(). Without it they show as [Typefill Pro].

(function (root) {
  "use strict";

  const FIELDS = new Set(["formtext", "formparagraph", "formmenu", "formtoggle", "formdate"]);
  // Stands for the caret while rendering, then taken out. A private-use character no one types.
  const CARET = String.fromCharCode(0xe000);
  // Stands for each key step ({key: tab}, {wait: 1}), in the order they come, while rendering
  const ACTION = String.fromCharCode(0xe001);
  // The parts Pro works out
  const PRO_TYPES = new Set(["if", "expr", "site", "lookup", "key", "wait"]);

  // What Pro registers: renderers by part type, and extra dropdown choices (from a sheet)
  const hooks = { renderers: {}, menuOptions: null };
  function extend(plugin) {
    Object.assign(hooks.renderers, plugin.renderers ?? {});
    if (plugin.menuOptions) hooks.menuOptions = plugin.menuOptions;
  }

  // Splits "a=1; b; c\;d" into named and plain arguments
  function parseArgs(src) {
    const parts = [];
    let cur = "";
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch === "\\" && i + 1 < src.length) { cur += src[++i]; continue; }
      if (ch === ";") { parts.push(cur); cur = ""; continue; }
      cur += ch;
    }
    parts.push(cur);
    const named = {}, plain = [];
    for (const raw of parts) {
      const p = raw.trim();
      if (!p) continue;
      const m = /^([a-zA-Z]+)\s*=\s*([\s\S]*)$/.exec(p);
      if (m) named[m[1].toLowerCase()] = m[2].trim();
      else plain.push(p);
    }
    return { named, plain };
  }

  // Text and commands in order. A toggle holds the parts up to its {endformtoggle}, an if its branches.
  // resolve(shortcut) gives another snippet's source for {import}; depth stops a snippet importing itself forever.
  function parse(text, resolve, depth = 0) {
    const top = [];
    // Each open block: the list new parts go into, and the toggle or if that owns it
    const frames = [{ list: top, owner: null }];
    const stack = { push: (list, owner) => frames.push({ list, owner }), top: () => frames[frames.length - 1] };
    const into = () => stack.top().list;
    let buf = "";
    const flush = () => { if (buf) { into().push({ type: "text", value: buf }); buf = ""; } };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\\" && (text[i + 1] === "{" || text[i + 1] === "}" || text[i + 1] === "\\")) { buf += text[++i]; continue; }
      if (ch !== "{") { buf += ch; continue; }
      // Find the matching close brace, skipping escaped ones
      let j = i + 1, inner = "";
      for (; j < text.length; j++) {
        if (text[j] === "\\" && j + 1 < text.length) { inner += text[j] + text[j + 1]; j++; continue; }
        if (text[j] === "}") break;
        inner += text[j];
      }
      if (j >= text.length) { buf += text.slice(i); break; }
      i = j;
      const m = /^\s*(=|[a-zA-Z]+)\s*:?\s*([\s\S]*)$/.exec(inner);
      if (!m) { buf += "{" + inner + "}"; continue; }
      const cmd = m[1].toLowerCase();
      flush();
      const owner = stack.top().owner;
      if (cmd === "=") {
        // A field's name repeats its answer. Anything else is a formula (Pro).
        into().push({ type: "expr", src: m[2].trim() });
      } else if (cmd === "endformtoggle") {
        if (owner?.type === "formtoggle") frames.pop();
      } else if (cmd === "if") {
        const node = { type: "if", branches: [{ cond: m[2].trim(), children: [] }], otherwise: null };
        into().push(node);
        stack.push(node.branches[0].children, node);
      } else if (cmd === "elseif" && owner?.type === "if" && !owner.otherwise) {
        const branch = { cond: m[2].trim(), children: [] };
        owner.branches.push(branch);
        frames.pop();
        stack.push(branch.children, owner);
      } else if (cmd === "else" && owner?.type === "if" && !owner.otherwise) {
        owner.otherwise = [];
        frames.pop();
        stack.push(owner.otherwise, owner);
      } else if (cmd === "endif") {
        if (owner?.type === "if") frames.pop();
      } else if (cmd === "import") {
        const source = depth < 5 && resolve ? resolve(parseArgs(m[2]).plain[0] ?? "") : null;
        if (source != null) into().push(...parse(source, resolve, depth + 1));
      } else {
        const node = { type: cmd, ...parseArgs(m[2]) };
        into().push(node);
        if (cmd === "formtoggle") { node.children = []; stack.push(node.children, node); }
      }
    }
    flush();
    return top;
  }

  // Every list of parts under a node: a toggle's, each branch of an if, and its else
  function childLists(node) {
    if (node.children) return [node.children];
    if (node.type === "if") return [...node.branches.map((b) => b.children), ...(node.otherwise ? [node.otherwise] : [])];
    return [];
  }

  // Pro parts: if blocks, formulas, page data, sheet data, key steps. A plain {=Field} repeat is free.
  function proParts(tree, fieldNames = new Set(fields(tree).map((f) => f.name.toLowerCase()))) {
    const found = new Set();
    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.type === "if") found.add("if blocks");
        if (node.type === "expr" && !fieldNames.has(node.src.toLowerCase())) found.add("formulas");
        if (node.type === "site") found.add("page data");
        if (node.type === "lookup" || (node.type === "formmenu" && node.named?.sheet)) found.add("sheet data");
        if (node.type === "key" || node.type === "wait") found.add("key steps");
        childLists(node).forEach(walk);
      }
    };
    walk(tree);
    return [...found];
  }

  // The form fields a template asks for, once each, in the order they first appear
  function fields(tree, now = new Date(), ctx = {}) {
    const out = [], seen = new Set();
    let n = 0;
    const walk = (nodes) => {
      for (const node of nodes) {
        if (FIELDS.has(node.type)) {
          if (!node.named.name) node.named.name = `${labelFor(node.type)}${++n > 1 ? " " + n : ""}`;
          const name = node.named.name;
          if (!seen.has(name)) {
            seen.add(name);
            const field = { kind: node.type, name, default: node.named.default ?? "" };
            if (node.type === "formmenu") {
              const extra = hooks.menuOptions ? hooks.menuOptions(node, ctx) : [];
              field.options = [...new Set([...(node.named.default !== undefined ? [node.named.default] : []), ...node.plain, ...extra])];
              if (!field.default) field.default = field.options[0] ?? "";
            }
            if (node.type === "formtoggle") field.default = !/^(no|false|off|0)$/i.test(node.named.default ?? "yes");
            if (node.type === "formdate") field.default = dateDefault(node.named.default, now);
            out.push(field);
          }
        }
        // Fields inside every branch of an if are asked for, whichever branch ends up used
        childLists(node).forEach(walk);
      }
    };
    walk(tree);
    return out;
  }

  function labelFor(kind) {
    return { formtext: "Text", formparagraph: "Paragraph", formmenu: "Choice", formtoggle: "Include", formdate: "Date" }[kind];
  }

  // A date field holds YYYY-MM-DD. Its default is a date like that, or a shift from today like +7D.
  function dateDefault(def, now) {
    if (def && /^\d{4}-\d{2}-\d{2}$/.test(def)) return def;
    return formatDate(shiftDate(now, def || ""), "YYYY-MM-DD");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]).replace(/\n/g, "<br>");
  }

  // Turns the template into what gets typed. The caret mark sits where {cursor} was, if anywhere.
  // With html set, the source is HTML and every value put into it is escaped.
  function render(tree, values, ctx, html = false) {
    let out = "", caret = false;
    ctx.actions = [];
    const put = (v) => { out += html ? escapeHtml(v) : String(v); };
    // What a Pro renderer works with
    const r = { values, ctx, put, walk: null, step: (action) => { out += ACTION; ctx.actions.push(action); } };
    const walk = (nodes) => {
      for (const node of nodes) {
        if (PRO_TYPES.has(node.type)) {
          // A plain {=Field} repeat is free and worked out here
          if (node.type === "expr") {
            const exact = Object.keys(values).find((k) => k.toLowerCase() === node.src.toLowerCase());
            if (exact !== undefined) { put(values[exact] ?? ""); continue; }
          }
          const pro = hooks.renderers[node.type];
          if (pro) pro(node, r);
          else put("[Typefill Pro]");
          continue;
        }
        switch (node.type) {
          case "text": out += node.value; break;
          case "cursor": if (!caret) { out += CARET; caret = true; } break;
          case "clipboard": put(ctx.clipboard ?? ""); break;
          case "time": put(formatDate(shiftDate(ctx.now ?? new Date(), node.named.shift), node.plain[0] || "YYYY-MM-DD")); break;
          case "formtext": case "formparagraph": case "formmenu": put(values[node.named.name] ?? ""); break;
          case "formdate": {
            const v = values[node.named.name];
            const d = /^\d{4}-\d{2}-\d{2}$/.test(v ?? "") ? new Date(v + "T12:00:00") : null;
            put(d ? formatDate(d, node.named.format || node.plain[0] || "D MMMM YYYY") : "");
            break;
          }
          case "formtoggle": if (values[node.named.name]) walk(node.children); break;
          default:
            // Unknown commands are typed as they were written
            put(`{${node.type}${node.plain.length || Object.keys(node.named).length ? ": " + [...Object.entries(node.named).map(([k, v]) => `${k}=${v}`), ...node.plain].join("; ") : ""}}`);
        }
      }
    };
    r.walk = walk;
    walk(tree);
    return out;
  }

  // Plain text and how far the caret goes back from the end, from a rendered plain template
  function splitCaret(text) {
    const at = text.indexOf(CARET);
    if (at < 0) return { text, back: 0 };
    const clean = text.replace(CARET, "");
    return { text: clean, back: clean.length - at };
  }

  // "+1D", "-2W", "+3M", "+1Y", "+4h", "-30m", several joined like "+1M-1D"
  function shiftDate(date, shift) {
    const d = new Date(date.getTime());
    if (!shift) return d;
    const re = /([+-]\d+)\s*([YMWDhm])/g;
    let m;
    while ((m = re.exec(shift))) {
      const n = parseInt(m[1], 10);
      switch (m[2]) {
        case "Y": d.setFullYear(d.getFullYear() + n); break;
        case "M": d.setMonth(d.getMonth() + n); break;
        case "W": d.setDate(d.getDate() + 7 * n); break;
        case "D": d.setDate(d.getDate() + n); break;
        case "h": d.setHours(d.getHours() + n); break;
        case "m": d.setMinutes(d.getMinutes() + n); break;
      }
    }
    return d;
  }

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function ordinal(n) {
    const s = n % 100;
    if (s >= 11 && s <= 13) return n + "th";
    return n + ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th");
  }

  // Moment-style tokens. Text in [brackets] is kept as it is.
  function formatDate(d, fmt) {
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    const h12 = d.getHours() % 12 || 12;
    const tokens = {
      YYYY: () => String(d.getFullYear()), YY: () => String(d.getFullYear()).slice(-2),
      MMMM: () => MONTHS[d.getMonth()], MMM: () => MONTHS[d.getMonth()].slice(0, 3), MM: () => pad(d.getMonth() + 1), M: () => String(d.getMonth() + 1),
      Do: () => ordinal(d.getDate()), DD: () => pad(d.getDate()), D: () => String(d.getDate()),
      dddd: () => DAYS[d.getDay()], ddd: () => DAYS[d.getDay()].slice(0, 3),
      HH: () => pad(d.getHours()), H: () => String(d.getHours()), hh: () => pad(h12), h: () => String(h12),
      mm: () => pad(d.getMinutes()), ss: () => pad(d.getSeconds()), A: () => (d.getHours() < 12 ? "AM" : "PM"), a: () => (d.getHours() < 12 ? "am" : "pm"),
    };
    return fmt.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|HH|H|hh|h|mm|ss|A|a/g, (t, lit) => (lit !== undefined ? lit : tokens[t]()));
  }

  root.TFTemplate = { parse, fields, render, splitCaret, formatDate, shiftDate, parseArgs, proParts, childLists, extend, CARET, ACTION };
})(typeof globalThis !== "undefined" ? globalThis : this);
