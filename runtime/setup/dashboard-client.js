'use strict';
(() => {
  const panel = document.getElementById('connection-health');
  if (!panel) return;
  const statusUrl = new URL('/status', location.origin);
  statusUrl.searchParams.set('token', new URL(location.href).searchParams.get('token') || '');
  let pending = false, failures = 0, previous = '', timer;
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
    for (const button of document.querySelectorAll('.site-action button')) button.disabled = health.local.state !== 'online';
    for (const record of health.accounts.slice(0, 100)) {
      if (!record || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(record.siteId) || !['verified', 'sign-in-required', 'not-checked'].includes(record.state)) continue;
      const card = Array.from(document.querySelectorAll('[data-site-id]')).find(element => element.dataset.siteId === record.siteId);
      if (!card) continue;
      const session = card.querySelector('.session-state');
      const activeLogin = health.login?.active === true && health.login.siteId === record.siteId;
      if (session) {
        session.classList.toggle('is-active', activeLogin);
        session.classList.toggle('is-saved', !activeLogin && Boolean(record.savedAt || card.dataset.saved === 'true'));
        if (record.savedAt) card.dataset.saved = 'true';
        if (session.querySelector('span') && (activeLogin || record.savedAt)) session.querySelector('span').textContent = activeLogin ? 'Sign-in in progress' : 'Session saved';
      }
      const label = card.querySelector('.account-label'), explanation = card.querySelector('.account-detail'), action = card.querySelector('.action-label');
      const values = record.state === 'sign-in-required' ? ['Sign-in required', 'Browsing is waiting for you to reconnect this account.', 'Reconnect account'] : record.state === 'verified' ? ['Last access verified', 'Verified during a website task. The site may ask you to sign in again later.', 'Sign in again'] : ['Sign-in status not checked', 'Your saved session will be checked during the next website task.', card.dataset.saved === 'true' ? 'Sign in again' : 'Connect website'];
      card.dataset.accountState = record.state;
      if (label && label.textContent !== values[0]) label.textContent = values[0];
      if (explanation && explanation.textContent !== values[1]) explanation.textContent = values[1];
      if (action && action.textContent !== values[2]) action.textContent = values[2];
      if (record.state === 'sign-in-required') required++;
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
    if (loginPanel && health.local.state === 'online') loginPanel.hidden = true;
    else if (loginPanel && health.mode === 'paused') loginPanel.hidden = false;
  }
  function unavailable(accessDenied = false) {
    const key = accessDenied ? 'access-required' : 'dashboard-offline';
    if (previous === key) return;
    previous = key; panel.dataset.health = 'offline';
    for (const button of document.querySelectorAll('.site-action button')) button.disabled = true;
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
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearTimeout(timer); poll(); } });
  poll();
})();
