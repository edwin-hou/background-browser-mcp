'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PrivateBrowserSessions = api;
})(globalThis, () => {
  const DAY = 86400000;
  function timestamp(value, now) {
    if (typeof value !== 'string' || !value) return null;
    const date = Date.parse(value);
    return Number.isFinite(date) && date >= 0 && date <= now + 60000 ? date : null;
  }
  function dateInfo(value, now) {
    const date = timestamp(value, now);
    if (date === null) return { label: 'Not recorded', title: 'No timestamp recorded', iso: '' };
    const age = Math.max(0, now - date), minutes = Math.floor(age / 60000), hours = Math.floor(age / 3600000), days = Math.floor(age / DAY);
    const label = minutes < 1 ? 'Just now' : minutes < 60 ? minutes + ' min ago' : hours < 24 ? hours + ' hr ago' : days + (days === 1 ? ' day ago' : ' days ago');
    return { label, title: new Date(date).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), iso: new Date(date).toISOString() };
  }
  function sessionView(record = {}, { now = Date.now(), active = false } = {}) {
    const savedAt = timestamp(record.savedAt, now);
    const verifiedValue = record.lastVerifiedAt || (record.state === 'verified' ? record.observedAt : null);
    const verifiedAt = timestamp(verifiedValue, now);
    const saved = dateInfo(record.savedAt, now), verified = dateInfo(verifiedValue, now);
    let kind, label, detail, actionLabel;
    if (active) {
      kind = 'signing-in'; label = 'Sign-in in progress'; detail = 'Finish signing in, then save the session to return to background browsing.'; actionLabel = 'Sign-in window open';
    } else if (record.state === 'sign-in-required') {
      kind = 'required'; label = 'Sign-in required'; detail = 'A sign-in page was detected. Browsing is waiting for you to reconnect this account.'; actionLabel = 'Reconnect account';
    } else if (record.state === 'verified' && verifiedAt !== null && now - verifiedAt < DAY && (savedAt === null || verifiedAt >= savedAt)) {
      kind = 'recent'; label = 'Last access verified'; detail = 'Account access worked within the last 24 hours. The website can still request sign-in later.'; actionLabel = 'Sign in again';
    } else if (savedAt === null && verifiedAt === null) {
      kind = 'never-saved'; label = 'No saved sign-in'; detail = 'No sign-in has been saved for this website card. Connect it here to save a session.'; actionLabel = 'Connect website';
    } else if (verifiedAt !== null && now - verifiedAt >= DAY && (savedAt === null || savedAt <= verifiedAt)) {
      kind = 'stale'; label = 'Not checked recently'; detail = 'Access was last verified ' + verified.label.toLowerCase() + '. The saved session may still work; your next website task can check it.'; actionLabel = 'Refresh sign-in';
    } else if (savedAt !== null && now - savedAt >= 7 * DAY) {
      kind = 'old-save'; label = 'Older saved sign-in'; detail = 'This sign-in was saved at least 7 days ago and has no recent access check. It may need refreshing.'; actionLabel = 'Refresh sign-in';
    } else {
      kind = 'unverified'; label = 'Saved, not verified'; detail = verifiedAt !== null && savedAt !== null && savedAt > verifiedAt ? 'A newer session was saved after the last access check. Account access will be verified when used.' : 'A session was saved, but account access has not been verified here. Your next website task can check it.'; actionLabel = 'Sign in again';
    }
    return { kind, label, detail, actionLabel, saved, verified, bucket: kind === 'required' ? 'required' : kind === 'never-saved' ? 'unsaved' : kind === 'recent' ? 'recent' : 'review' };
  }
  function summarize(views) {
    const counts = { required: 0, unsaved: 0, review: 0, recent: 0 };
    for (const view of views) if (Object.hasOwn(counts, view.bucket)) counts[view.bucket]++;
    return counts;
  }
  return { sessionView, summarize };
});
