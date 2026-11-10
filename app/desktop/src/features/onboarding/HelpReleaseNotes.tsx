import { useEffect, useMemo, useState } from 'react';
import { fetchWhatsNewRelease, releaseHighlights, type WhatsNewRelease } from '@/features/updates/whatsNew';

export function HelpReleaseNotes({ native, onVersion }: { native: boolean; onVersion?: (version: string) => void }) {
  const [release, setRelease] = useState<WhatsNewRelease | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const highlights = useMemo(() => (release ? releaseHighlights(release) : []), [release]);
  const version = release?.version;
  useEffect(() => { if (version) onVersion?.(version); }, [version, onVersion]);
  useEffect(() => {
    if (!native) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    let active = true;
    void import('@tauri-apps/api/app').then(async ({ getVersion }) => {
      const version = await getVersion();
      const bundled = { version, notes: '', publishedAt: '' };
      // The installed app already includes curated highlights for known releases.
      const result = releaseHighlights(bundled).length ? bundled : await fetchWhatsNewRelease(version, { signal: controller.signal });
      if (active) { setRelease(result); setStatus(result ? 'ready' : 'error'); }
    }).catch(() => { if (active) setStatus('error'); }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [native, attempt]);
  return <section className="help-article">
    {!native ? <p>Release highlights for your installed version are available in the desktop app.</p> : <>
      {status === 'loading' ? <p role="status">Loading release highlights…</p> : null}
      {status === 'error' ? <><p role="status">Couldn’t load the release notes. Try again in a moment.</p><button className="help-secondary" onClick={() => { setStatus('loading'); setAttempt((value) => value + 1); }}>Try again</button></> : null}
      {release ? <div className="help-release-list" role="list">{highlights.map((item) => <article className="help-release-item" role="listitem" key={item.title}><h3>{item.title}</h3>{item.detail ? <p>{item.detail}</p> : null}</article>)}</div> : null}
    </>}
  </section>;
}
