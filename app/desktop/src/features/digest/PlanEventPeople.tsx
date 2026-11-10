import { Check, X } from 'lucide-react';
import { planCardAttendance, planCardCountsLabel } from '@/features/cloud/planCardSnapshot';
import { PlanCardAvatar } from '@/kordi-app/components/planCard';
import type { MessagePlanCardParticipant } from '@/kordi-app/types/message';
import { planEventSelf, type PlanEventCard } from './planEventCard';

function PersonRow({ person, own }: { person: MessagePlanCardParticipant; own: boolean }) {
  return <li className="digest-plan-person">
    <PlanCardAvatar name={person.displayName} avatarUrl={person.avatarUrl} />
    <span className="digest-plan-person-name">{person.displayName}{own ? ' (you)' : ''}</span>
    {person.organizer && <span className="digest-plan-person-role">Organizer</span>}
  </li>;
}

/** Who is going, who can't make it and who has not replied, with the member's own answer. */
export function PlanEventPeople({ plan, busy, onYes, onNo }: { plan: PlanEventCard; busy: boolean; onYes: () => void; onNo: () => void }) {
  const attendance = planCardAttendance(plan.card.participants);
  const self = planEventSelf(plan);
  const canRespond = Boolean(self && !self.organizer && plan.card.state !== 'canceled');
  const groups: [string, MessagePlanCardParticipant[]][] = [['Going', attendance.going], ["Can't make it", attendance.declined], ['No reply', attendance.waiting]];
  return <section className="digest-plan-people" aria-label="People">
    <div className="digest-plan-head">
      <span>People</span>
      <span className="digest-plan-counts">{planCardCountsLabel(attendance)}</span>
      {canRespond && <div className="digest-plan-actions" role="group" aria-label="Your answer">
        <button type="button" aria-pressed={self?.rsvp === 'no'} className={self?.rsvp === 'no' ? 'digest-plan-selected' : undefined} disabled={busy} onClick={onNo}><X size={12} aria-hidden />Can't make it</button>
        <button type="button" aria-pressed={self?.rsvp === 'yes'} className={self?.rsvp === 'yes' ? 'digest-plan-selected' : undefined} disabled={busy} onClick={() => { if (self?.rsvp !== 'yes') onYes(); }}><Check size={12} aria-hidden />I'm in</button>
      </div>}
    </div>
    <div className="digest-plan-groups">
      {groups.map(([title, people]) => people.length > 0 && <div key={title} className="digest-plan-group">
        <div className="digest-plan-group-title">{title}</div>
        <ul>{people.map(person => <PersonRow key={person.participantId} person={person} own={person.participantId === plan.accountId} />)}</ul>
      </div>)}
    </div>
  </section>;
}
