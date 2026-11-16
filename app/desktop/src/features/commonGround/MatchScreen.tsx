import { useState } from 'react';

import type { CgHost } from './host';
import { PersonActions } from './PersonActions';
import { CgAvatar, CgBack, CgGroup, CgNotice, CgProgress, CgRow, CgSection, CgSegmented, CgTopicDot } from './parts';
import { personTitle } from './profiles';
import { personKey, type CgState, type CommonGroundStore } from './store';
import type { CgMatch, CgTrade } from './types';

function lowerFirst(text: string) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function TradeRows({ items, whose }: { items: CgTrade[]; whose: string }) {
  return (
    <CgGroup>
      {items.map((trade) => (
        <CgRow
          key={`${trade.topic}:${trade.for}`}
          lead={<CgTopicDot topic={trade.topic} />}
          title={trade.topic}
          sub={trade.for ? `For ${whose} ${lowerFirst(trade.for)}` : undefined}
        />
      ))}
    </CgGroup>
  );
}

/**
 * Shared and Trade for a found match, or a line while it is being found. While matching, newer servers
 * send the quick estimate's topics without reasons; those show at once above the progress line.
 */
export function MatchDetails({ match }: { match: Pick<CgMatch, 'status' | 'person' | 'shared' | 'youBring' | 'theyBring' | 'nextStep'> }) {
  const [tab, setTab] = useState<'shared' | 'trade'>('shared');
  const person = match.person;
  const shared = match.shared ?? [];
  const youBring = match.youBring ?? [];
  const theyBring = match.theyBring ?? [];
  const matching = match.status === 'matching';
  if (matching && !shared.length && !youBring.length && !theyBring.length) return <CgProgress line="Finding what you share" />;
  if (match.status === 'failed') return <CgNotice text="Could not find a match. Try again later." />;
  // While matching, an empty list stays empty instead of saying there is no overlap.
  const emptyRow = (line: string) => (matching ? null : <CgSection><CgGroup><CgRow title={<span className="cg-muted">{line}</span>} /></CgGroup></CgSection>);
  return (
    <>
      <CgSegmented value={tab} onChange={setTab} label="Match" options={[['shared', 'Shared'], ['trade', 'Trade']]} />
      {tab === 'shared' ? (
        shared.length ? (
          <CgSection>
            <CgGroup>
              {shared.map((reason) => <CgRow key={reason.topic} lead={<CgTopicDot topic={reason.topic} />} title={reason.topic} sub={reason.why || undefined} />)}
            </CgGroup>
          </CgSection>
        ) : emptyRow('No clear overlap yet')
      ) : youBring.length || theyBring.length ? (
        <>
          {youBring.length ? <CgSection title="You bring"><TradeRows items={youBring} whose={`${person.name}'s`} /></CgSection> : null}
          {theyBring.length ? <CgSection title={`${person.name} brings`}><TradeRows items={theyBring} whose="your" /></CgSection> : null}
        </>
      ) : emptyRow('No clear trade yet')}
      {match.nextStep ? <div className="cg-next-step">{match.nextStep}</div> : null}
      {matching ? <CgProgress inline line="Finding what you share" /> : null}
    </>
  );
}

export function MatchScreen({ accountId, profileId, state, store, host }: {
  accountId: string;
  profileId?: string;
  state: CgState;
  store: CommonGroundStore;
  host: CgHost;
}) {
  const match = state.matches[personKey(accountId, profileId)];
  if (!match) {
    return (
      <>
        <CgBack onBack={() => store.back()} />
        {state.notice ? <CgNotice text={state.notice} /> : <CgProgress line="Reading cards" />}
      </>
    );
  }
  const person = match.person;
  const ready = match.status === 'ready';
  return (
    <>
      <CgBack onBack={() => store.back()} />
      <div className="cg-hero">
        <span className="cg-pair">
          <CgAvatar person={host.self} size={64} ring isSelf />
          <CgAvatar person={person} size={64} ring />
        </span>
        {ready ? <span className="cg-badge">{match.score ?? 0}%</span> : null}
        <h1>{personTitle(person)}</h1>
        {person.handle ? <div className="cg-hero-line cg-hero-handle">@{person.handle}</div> : null}
        {ready && match.headline ? <div className="cg-hero-line">{match.headline}</div> : null}
      </div>
      <PersonActions person={person} state={state} store={store} host={host} />
      <CgNotice text={state.notice} />
      <MatchDetails match={match} />
    </>
  );
}
