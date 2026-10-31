// Runs in the page's own world. Two jobs the content script can't do from its separate world:
// a made-up paste the page can read (Firefox empties one made outside the page), and key presses with a keyCode
// (Google Docs reads keyCode, which only this world can set on a made-up key event).

(() => {
  "use strict";
  if (window.__typefillPageMain) return;
  window.__typefillPageMain = true;

  // The answer goes back on the root element, since the content script reads it straight after sending
  window.addEventListener("typefill-paste", (e) => {
    let detail;
    try { detail = JSON.parse(e.detail); } catch { return; }
    const { text, html } = detail;
    const init = { bubbles: true, cancelable: true, composed: true };
    let ev;
    try {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      if (html) data.setData("text/html", html);
      ev = new ClipboardEvent("paste", { ...init, clipboardData: data });
      if (ev.clipboardData?.getData("text/plain") !== text) throw new Error("no data");
    } catch {
      // Firefox: one type goes in through the event's own fields, the other is added after
      ev = new ClipboardEvent("paste", { ...init, dataType: html ? "text/html" : "text/plain", data: html ?? text });
      if (html) try { ev.clipboardData.setData("text/plain", text); } catch { /* html only then */ }
    }
    deepActive().dispatchEvent(ev);
    document.documentElement.setAttribute("data-typefill-pasted", ev.defaultPrevented ? "1" : "0");
  });

  // Typing or deleting as a key press would ask for it, naming the exact range, for editors that do their own editing
  for (const [name, inputType] of [["typefill-insert", "insertText"], ["typefill-delete", "deleteContentBackward"]]) {
    window.addEventListener(name, (e) => {
      const sel = document.getSelection();
      let ev;
      try {
        ev = new InputEvent("beforeinput", { inputType, data: inputType === "insertText" ? e.detail : null, bubbles: true, cancelable: true, composed: true, targetRanges: sel.rangeCount ? [new StaticRange(sel.getRangeAt(0))] : [] });
      } catch { return; }
      deepActive().dispatchEvent(ev);
      document.documentElement.setAttribute("data-typefill-pasted", ev.defaultPrevented ? "1" : "0");
    });
  }

  // One key press for a key step ({key: enter}). The answer says whether the page acted on it itself.
  window.addEventListener("typefill-key-one", (e) => {
    let detail;
    try { detail = JSON.parse(e.detail); } catch { return; }
    const target = deepActive();
    let taken = false;
    for (const type of ["keydown", "keypress", "keyup"]) {
      if (type === "keypress" && detail.key !== "Enter") continue;
      const ev = new KeyboardEvent(type, { key: detail.key, code: detail.key === " " ? "Space" : detail.key, shiftKey: !!detail.shiftKey, bubbles: true, cancelable: true, composed: true });
      Object.defineProperty(ev, "keyCode", { get: () => detail.keyCode });
      Object.defineProperty(ev, "which", { get: () => detail.keyCode });
      target.dispatchEvent(ev);
      if (type === "keydown") taken = ev.defaultPrevented;
    }
    document.documentElement.setAttribute("data-typefill-pasted", taken ? "1" : "0");
  });

  window.addEventListener("typefill-key", (e) => {
    let detail;
    try { detail = JSON.parse(e.detail); } catch { return; }
    const target = deepActive();
    for (const type of ["keydown", "keyup"]) {
      const ev = new KeyboardEvent(type, { key: detail.key, code: detail.key, bubbles: true, cancelable: true });
      Object.defineProperty(ev, "keyCode", { get: () => detail.keyCode });
      Object.defineProperty(ev, "which", { get: () => detail.keyCode });
      target.dispatchEvent(ev);
    }
  });

  function deepActive() {
    let el = document.activeElement ?? document.body;
    while (el.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }
})();
