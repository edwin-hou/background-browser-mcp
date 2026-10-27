'use strict';
(() => {
  const panel = document.getElementById('connection-health');
  if (!panel) return;
  const sessionApi = globalThis.PrivateBrowserSessions;
  const sessionDetailsReady = typeof sessionApi?.sessionView === 'function' && typeof sessionApi?.summarize === 'function';
  const statusUrl = new URL('/status', location.origin);
  statusUrl.searchParams.set('token', new URL(location.href).searchParams.get('token') || '');
  let pending = false, finishing = false, failures = 0, previous = '', lastRequestFailureKey = '', timer;
  const text = (id, value) => { const element = document.getElementById(id); if (element && element.textContent !== value) element.textContent = value; };
  const labels = { online: 'Connected', offline: 'Offline', paused: 'Signing in', stopped: 'Stopped', checking: 'Checking', unconfigured: 'Not configured' };
  function render(health) {
    const states = ['online', 'offline', 'paused', 'stopped', 'checking', 'unconfigured'];
    if (health.version !== 1 || !states.includes(health.mode) || !states.includes(health.local?.state) || !states.includes(health.remote?.state) || !Array.isArray(health.accounts)) throw new Error('Invalid status.');
    let title = 'Checking your connection', detail = 'Checking the browser without opening any websites.', mode = health.mode;
    if (mode === 'online') { title = 'Your browser is connected'; detail = 'The browser is ready. ChatGPT access and website sign-in are checked when you request a browser task.'; }
    if (mode === 'offline') { title = health.local.state === 'online' ? 'ChatGPT gateway is offline' : 'Background Browser is offline'; detail = health.local.state === 'online' ? 'ChatGPT browser tasks are waiting for you to reconnect. Check the connection settings below.' : 'Browser tasks are waiting for you to reconnect the local service. Your website sign-ins are separate from this connection.'; }
    if (mode === 'paused') { title = 'Waiting for you to finish signing in'; detail = 'Finish in the separate login window, then save the session to return to background browsing.'; }
    if (mode === 'stopped') { title = 'Background Browser is stopped'; detail = 'Browser tasks are waiting. Start Background Browser when you are ready to reconnect.'; }
    let required = 0;
    const sessionViews = [];
    const setTime = (element, info) => { if (!element) return; element.textContent = info.label; element.title = info.title; if (info.iso) element.setAttribute('datetime', info.iso); else element.removeAttribute('datetime'); };
    for (const button of document.querySelectorAll('.site-action button')) button.disabled = health.local.state !== 'online' || health.login?.active === true;
    for (const record of health.accounts.slice(0, 100)) {
      if (!record || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(record.siteId) || !['verified', 'sign-in-required', 'not-checked'].includes(record.state)) continue;
      const card = Array.from(document.querySelectorAll('[data-site-id]')).find(element => element.dataset.siteId === record.siteId);
      if (!card) continue;
      const activeLogin = health.login?.active === true && health.login.siteId === record.siteId;
      if (!sessionDetailsReady) {
        const requiresSignIn = record.state === 'sign-in-required';
        card.dataset.sessionKind = requiresSignIn ? 'required' : 'unverified';
        const label = card.querySelector('.account-label'), detail = card.querySelector('.account-detail');
        if (label) label.textContent = requiresSignIn ? 'Sign-in required' : 'Session details unavailable';
        if (detail) detail.textContent = requiresSignIn ? 'Browsing is waiting for you to reconnect this account.' : 'Refresh this page to load sign-in history. Connection checks are still running.';
        if (requiresSignIn) required++;
        continue;
      }
      const view = sessionApi.sessionView(record, { active: activeLogin });
      sessionViews.push(view);
      const session = card.querySelector('.session-state');
      if (session) {
        session.classList.toggle('is-active', activeLogin);
        session.classList.toggle('is-saved', !activeLogin && Boolean(view.saved.iso));
        if (session.querySelector('span')) session.querySelector('span').textContent = activeLogin ? 'Sign-in in progress' : view.saved.iso ? 'Session saved in this browser' : 'No saved checkpoint';
      }
      card.dataset.saved = String(Boolean(view.saved.iso));
      card.dataset.accountState = record.state;
      card.dataset.sessionKind = view.kind;
      const label = card.querySelector('.account-label'), explanation = card.querySelector('.account-detail'), action = card.querySelector('.action-label');
      if (label) label.textContent = view.label;
      if (explanation) explanation.textContent = view.detail;
      if (action) action.textContent = view.actionLabel;
      const button = card.querySelector('.site-action button');
      if (button) { const prominent = ['required', 'never-saved'].includes(view.kind); button.classList.toggle('secondary', prominent); button.classList.toggle('subtle', !prominent); }
      setTime(card.querySelector('.saved-time'), view.saved);
      setTime(card.querySelector('.verified-time'), view.verified);
      if (view.bucket === 'required') required++;
    }
    if (sessionDetailsReady) {
      const sessionCounts = sessionApi.summarize(sessionViews);
      for (const [key, count] of Object.entries(sessionCounts)) text('session-count-' + key, String(count));
    } else {
      text('session-overview-title', 'Session details unavailable');
      for (const key of ['required', 'unsaved', 'review', 'recent']) text('session-count-' + key, '—');
      const explanation = document.querySelector('#session-overview > p');
      if (explanation) explanation.textContent = 'Refresh this page to load sign-in history. Connection checks are still running.';
    }
    const failedRequests = [];
    for (const channel of ['chatgpt', 'codex']) {
      const record = health.requests?.[channel] || {state:'unseen'};
      const fallbackState = ['unseen','succeeded','failed','unavailable'].includes(record.state) ? record.state : 'unavailable';
      const view = typeof sessionApi?.connectionView === 'function' ? sessionApi.connectionView(record) : {state:fallbackState,label:{unseen:'No request seen',succeeded:'Reached browser',failed:'Request failed',unavailable:'Status unavailable'}[fallbackState],detail:fallbackState==='failed' ? 'A browser request failed. Account tasks must wait for reconnection; verify any uncertain action before retrying.' : 'Refresh the page to load request details.',uncertainEarlierAction:record.completion==='unknown' && fallbackState==='succeeded'};
      const name = channel === 'chatgpt' ? 'ChatGPT' : 'Codex';
      text('request-' + channel + '-summary', name + ': ' + view.label + (view.uncertainEarlierAction ? ' · Earlier action unconfirmed' : ''));
      const summary = document.getElementById('request-' + channel + '-summary'), row = document.querySelector('[data-request-channel="' + channel + '"]');
      if (summary) { summary.dataset.requestState = view.state; summary.dataset.requestUncertain = String(view.uncertainEarlierAction); }
      if (row) row.dataset.requestState = view.state;
      text('request-' + channel + '-detail', view.detail);
      if (view.lastContact) setTime(document.getElementById('request-' + channel + '-contact'), view.lastContact);
      if (view.lastSuccess) setTime(document.getElementById('request-' + channel + '-success'), view.lastSuccess);
      if (view.lastFailure) setTime(document.getElementById('request-' + channel + '-failure'), view.lastFailure);
      const uncertain = document.getElementById('request-' + channel + '-uncertain');
      if (uncertain) uncertain.hidden = !view.uncertainEarlierAction;
      if (view.state === 'failed') failedRequests.push({channel,name,record,view});
    }
    const failureKey = failedRequests.map(value => value.channel + ':' + (value.record.lastFailureAt || 'unknown')).join('|');
    if (failureKey && failureKey !== lastRequestFailureKey) { const details = document.getElementById('request-status'); if (details) details.open = true; }
    lastRequestFailureKey = failureKey;
    if (failedRequests.length && mode === 'online') {
      mode = 'request-failed';
      title = failedRequests.length === 1 ? failedRequests[0].name + ' browser request failed' : 'Browser requests are waiting for reconnection';
      detail = failedRequests[0].view.detail + (required ? ' ' + required + (required === 1 ? ' account also needs sign-in.' : ' accounts also need sign-in.') : '');
    }
    if (required && mode === 'online') { title = required === 1 ? 'One account needs sign-in' : required + ' accounts need sign-in'; detail = 'Tasks for those accounts are waiting for you. Use the highlighted website cards to reconnect.'; mode = 'attention'; }
    const key = [mode, title, detail, health.local.state, health.remote.state].join('|');
    if (key !== previous) {
      previous = key; panel.dataset.health = mode;
      text('connection-health-title', title); text('connection-health-detail', detail);
      text('local-connection-state', labels[health.local.state]); text('remote-connection-state', health.remote.state === 'online' ? 'Reachable' : labels[health.remote.state]);
      const browserState = document.querySelector('.browser-state');
      if (browserState) {
        const dot = document.createElement('span'); dot.className = 'status-dot' + (health.local.state === 'online' ? '' : ' amber');
        const label = { online: 'Running in background', offline: 'Connection offline', paused: 'Sign-in window open', stopped: 'Browser stopped', checking: 'Checking connection' }[health.local.state] || 'Checking connection';
        browserState.replaceChildren(dot, document.createTextNode(label));
      }
      const browserDetail = document.querySelector('.browser-status > p');
      if (browserDetail) browserDetail.textContent = { online: 'Ready for your next task. No browser window needed.', offline: 'Browsing is waiting for you to reconnect.', paused: 'Complete sign-in, then save your session.', stopped: 'Start Background Browser when you are ready to reconnect.', checking: 'Checking your dedicated browser connection.' }[health.local.state] || 'Checking your dedicated browser connection.';
    }
    const loginPanel = document.querySelector('.login-panel');
    const phase = ['idle', 'opening', 'ready'].includes(health.login?.phase) ? health.login.phase : 'idle';
    if (loginPanel) { loginPanel.hidden = false; loginPanel.dataset.loginPhase = phase; loginPanel.dataset.loginFailed = String(health.login?.failed === true); }
    const site = health.login?.siteName || 'your website';
    text('login-title', phase === 'ready' ? 'Finish connecting ' + site : phase === 'opening' ? 'Opening ' + site : health.login?.failed === true ? 'Sign-in did not finish' : 'Sign-in window');
    text('login-detail', phase === 'ready' ? 'Finish signing in, then save to close the window and return to background browsing.' : phase === 'opening' ? 'Wait for the window to open, then complete sign-in.' : health.login?.failed === true ? 'Open the website again to finish sign-in and save its session.' : 'No sign-in window is open.');
    const finishButton = document.getElementById('finish-login-button');
    if (finishButton) finishButton.disabled = finishing || phase !== 'ready' || health.login?.canFinish !== true;

  }
  function unavailable(accessDenied = false) {
    const key = accessDenied ? 'access-required' : 'dashboard-offline';
    if (previous === key) return;
    previous = key; panel.dataset.health = 'offline';
    for (const button of document.querySelectorAll('.site-action button')) button.disabled = true;
    const finishButton = document.getElementById('finish-login-button');
    if (finishButton) finishButton.disabled = true;
    const loginPanel = document.querySelector('.login-panel');
    if (loginPanel) { loginPanel.hidden = false; loginPanel.dataset.loginPhase = 'unavailable'; }
    text('login-title', 'Sign-in window status unavailable');
    text('login-detail', 'The save button will be available when the connection can verify your sign-in window.');
    for (const channel of ['chatgpt','codex']) {
      text('request-' + channel + '-summary', (channel === 'chatgpt' ? 'ChatGPT' : 'Codex') + ': Status unavailable');
      text('request-' + channel + '-detail', 'Request history cannot currently be checked. The page will keep checking.');
      const summary = document.getElementById('request-' + channel + '-summary'), row = document.querySelector('[data-request-channel="' + channel + '"]');
      if (summary) summary.dataset.requestState = 'unavailable';
      if (row) row.dataset.requestState = 'unavailable';
    }
    text('connection-health-title', accessDenied ? 'Open your private setup shortcut' : 'Connection status is unavailable');
    text('connection-health-detail', accessDenied ? 'This page no longer has setup access. Reopen your saved shortcut; browser tasks will wait for reconnection.' : 'Browser tasks are waiting. Reopen your setup shortcut after the local service reconnects. This page will keep checking.');
    text('local-connection-state', 'Status unavailable'); text('remote-connection-state', 'Status unavailable');
    const browserState = document.querySelector('.browser-state'), browserDetail = document.querySelector('.browser-status > p');
    if (browserState) browserState.textContent = 'Status unavailable';
    if (browserDetail) browserDetail.textContent = 'The browser connection cannot currently be checked.';
  }
  async function poll() {
    if (pending) return;
    pending = true;
    try {
      const response = await fetch(statusUrl, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(4500) });
      if (response.status === 403) { unavailable(true); failures = 3; return; }
      if (!response.ok) throw new Error('Status unavailable.');
      render(await response.json()); failures = 0;
    } catch { if (++failures >= 3) unavailable(); }
    finally {
      pending = false; clearTimeout(timer);
      timer = setTimeout(poll, document.hidden || failures >= 3 ? 15000 : 5000);
    }
  }
  const finishForm = document.getElementById('finish-login-button')?.closest('form');
  finishForm?.addEventListener('submit', event => {
    if (finishing) { event.preventDefault(); return; }
    finishing = true;
    const button = document.getElementById('finish-login-button');
    button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = 'Saving session…';
  });
  for (const link of document.querySelectorAll('a[href^="#"]')) link.addEventListener('click', () => {
    const id = link.getAttribute('href').slice(1);
    if (!['add-website', 'connections', 'connection-settings'].includes(id)) return;
    const target = document.getElementById(id);
    const details = target?.tagName === 'DETAILS' ? target : target?.querySelector('details');
    if (details) details.open = true;
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearTimeout(timer); poll(); } });
  poll();
})();
