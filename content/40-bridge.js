/*
 * Loupe — popup bridge.
 * The popup cannot read the active tab's URL without the "tabs" permission, so
 * it asks the top-frame content script where it is. Adds no permission.
 */
(function (root) {
  'use strict';
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;
  if (root.top !== root) return; // top frame only — iframes would answer with the wrong host

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg || msg.type !== 'loupe:where') return undefined;
    sendResponse({ hostname: root.location.hostname, origin: root.location.origin });
    return undefined;
  });
})(globalThis);