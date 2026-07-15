// Guest-side webxdc API shim. It replaces the app's packaged
// webxdc.js: src/bundle.js inlines it (behind a prelude that
// defines window.__vaultInfo and window.__vaultFiles) into
// the guest document, so selfAddr/selfName are identical to
// the outer webxdc values and available at script evaluation
// time. All webxdc calls bridge to the vault via postMessage.

window.webxdc = (() => {
  const info = window.__vaultInfo || {
    selfAddr: 'unknown', selfName: 'unknown',
    hasRealtime: false,
  };

  let updateListener = null;
  let replayDone = null;
  let realtimeListener = null;
  let importResolve = null;
  let sendToChatPending = null;

  window.addEventListener('message', ev => {
    if (ev.source !== window.parent || !ev.data) return;
    if (ev.data.type === 'vault-update') {
      if (updateListener) updateListener(ev.data.update);
    } else if (ev.data.type === 'vault-replay-done') {
      if (replayDone) { replayDone(); replayDone = null; }
    } else if (ev.data.type === 'vault-realtime-data') {
      if (realtimeListener) {
        realtimeListener(new Uint8Array(ev.data.data));
      }
    } else if (ev.data.type === 'vault-importFiles-result') {
      if (importResolve) {
        importResolve(ev.data.files);
        importResolve = null;
      }
    } else if (ev.data.type === 'vault-sendToChat-result') {
      if (sendToChatPending) {
        if (ev.data.ok) sendToChatPending.res();
        else sendToChatPending.rej(new Error(ev.data.error));
        sendToChatPending = null;
      }
    }
  });

  const api = {
    selfAddr: info.selfAddr,
    selfName: info.selfName,
    sendUpdate: (update, _descr) => {
      window.parent.postMessage(
        { type: 'vault-sendUpdate', update }, '*');
    },
    setUpdateListener: (cb, serial = 0) => {
      updateListener = cb;
      const done = new Promise(r => { replayDone = r; });
      window.parent.postMessage(
        { type: 'vault-setUpdateListener', serial }, '*');
      return done;
    },
    sendUpdateInterval: 1000,
    sendUpdateMaxSize:
      info.sendUpdateMaxSize || 128 * 1024,
  };

  if (info.hasRealtime) {
    api.joinRealtimeChannel = () => {
      window.parent.postMessage(
        { type: 'vault-realtime-join' }, '*');
      return {
        setListener: (fn) => { realtimeListener = fn; },
        send: (data) => {
          window.parent.postMessage(
            { type: 'vault-realtime-send', data }, '*');
        },
        leave: () => {
          realtimeListener = null;
          window.parent.postMessage(
            { type: 'vault-realtime-leave' }, '*');
        },
      };
    };
  }

  if (info.hasImportFiles) {
    // opens the *outer* runtime's local file picker; the
    // picked File objects are structured-cloned back in
    api.importFiles = (filter) => {
      const done = new Promise(r => { importResolve = r; });
      window.parent.postMessage(
        { type: 'vault-importFiles', filter }, '*');
      return done;
    };
  }

  if (info.hasSendToChat) {
    // sharing content out of the encrypted room is an
    // explicit user choice: the outer runtime shows its
    // confirmation dialog before anything leaves
    api.sendToChat = (content) =>
      new Promise((res, rej) => {
        sendToChatPending = { res, rej };
        window.parent.postMessage(
          { type: 'vault-sendToChat', content }, '*');
      });
  }

  return api;
})();
