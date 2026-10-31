// Formatted snippets: keeps their HTML to a safe set of tags, and turns it into plain text for boxes that take no formatting.

(function (root) {
  "use strict";

  const KEEP = new Set(["B", "STRONG", "I", "EM", "U", "S", "A", "BR", "P", "DIV", "SPAN", "UL", "OL", "LI", "H1", "H2", "H3", "BLOCKQUOTE", "CODE", "PRE", "IMG"]);
  const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "NOSCRIPT", "LINK", "META"]);
  const BLOCK = new Set(["P", "DIV", "LI", "H1", "H2", "H3", "BLOCKQUOTE", "PRE", "UL", "OL"]);

  function parseHtml(html) {
    return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
  }

  // Only the tags above, links to web or mail addresses, pictures from web addresses, and no styles or scripts
  function sanitize(html) {
    const body = parseHtml(html);
    const clean = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.TEXT_NODE) continue;
        if (child.nodeType !== Node.ELEMENT_NODE || DROP.has(child.tagName)) { child.remove(); continue; }
        clean(child);
        if (!KEEP.has(child.tagName)) { child.replaceWith(...child.childNodes); continue; }
        for (const attr of [...child.attributes]) {
          const ok = (child.tagName === "A" && attr.name === "href" && /^(https?:|mailto:)/i.test(attr.value))
            || (child.tagName === "IMG" && attr.name === "src" && /^https:/i.test(attr.value))
            || (child.tagName === "IMG" && attr.name === "alt");
          if (!ok) child.removeAttribute(attr.name);
        }
        if (child.tagName === "IMG" && !child.getAttribute("src")) child.remove();
      }
    };
    clean(body);
    return body.innerHTML;
  }

  // Line breaks where the formatting has blocks or <br>, bullets for list items
  function toText(html) {
    const body = parseHtml(html);
    let out = "";
    const walk = (node, list) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) { out += child.data.replace(/[ \t\r\n]+/g, " "); continue; }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = child.tagName;
        if (tag === "BR") { out += "\n"; continue; }
        if (tag === "IMG") { out += child.getAttribute("alt") ?? ""; continue; }
        const block = BLOCK.has(tag);
        if (block && out && !out.endsWith("\n")) out += "\n";
        if (tag === "LI") out += list?.tagName === "OL" ? `${[...list.children].indexOf(child) + 1}. ` : "• ";
        if (tag === "A") {
          walk(child, list);
          const href = child.getAttribute("href");
          if (href && href !== child.textContent && !href.startsWith("mailto:")) out += ` (${href})`;
          continue;
        }
        walk(child, tag === "UL" || tag === "OL" ? child : list);
        if (block && !out.endsWith("\n")) out += "\n";
      }
    };
    walk(body, null);
    return out.replace(/\n+$/, "");
  }

  function fromText(text) {
    return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]).replace(/\n/g, "<br>");
  }

  root.TFHtml = { sanitize, toText, fromText };
})(typeof globalThis !== "undefined" ? globalThis : this);
