import { Check, ChevronDown, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import { memoryCategoriesOf, memoryCategoryLabel, type MemoryCategory } from './memoryCategory';
import type { MemoryLesson } from './memoryModel';
import type { MemoryOrigin } from './memoryOrigin';
import {
  EVERY_CARD,
  addableCards,
  cardLabel,
  categoryChecklist,
  categoryChoices,
  memoryRowCards,
  toggleMemoryCategory,
  type MemoryCard,
  type MemoryFilterLayer,
} from './memoryOrganizerModel';

type OpenMenu = 'category' | 'card' | null;

/** Closes a menu on Escape or a click outside `ref`, which holds the menu and its trigger. */
function useMenuDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node | null)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape closes the menu, not the settings dialog around it.
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [ref, open, onClose]);
}

function MenuWrap({ open, onClose, trigger, children }: { open: boolean; onClose: () => void; trigger: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useMenuDismiss(ref, open, onClose);
  return (
    <span ref={ref} className="mo-wrap">
      {trigger}
      {open ? <span className="mo-menu" role="menu">{children}</span> : null}
    </span>
  );
}

export type MemoryLabelsProps = {
  lesson: MemoryLesson;
  cards: readonly MemoryCard[];
  origin: MemoryOrigin;
  onToggleFilter: (layer: MemoryFilterLayer, value: string) => void;
  /** The category menu; false shows the categories as plain labels. */
  categoryEditable: boolean;
  /** Up to three categories, chosen from a checklist (`memoryVersion` 4); false keeps one, chosen from a list. */
  multiCategory?: boolean;
  /** Card labels and their controls (`memoryVersion` 3). */
  cardsEnabled: boolean;
  busy: boolean;
  onChangeCategory: (category: MemoryCategory) => void;
  /** The whole new set of categories after one is ticked or unticked (`multiCategory`). */
  onChangeCategories?: (categories: MemoryCategory[]) => void;
  onAddCard: (profileId: string) => void;
  onRemoveCard: (profileId: string) => void;
};

/** The labels under a memory: its categories, its cards and where it came from. Each label toggles its filter. */
export function MemoryLabels({
  lesson,
  cards,
  origin,
  onToggleFilter,
  categoryEditable,
  multiCategory = false,
  cardsEnabled,
  busy,
  onChangeCategory,
  onChangeCategories,
  onAddCard,
  onRemoveCard,
}: MemoryLabelsProps) {
  const [menu, setMenu] = useState<OpenMenu>(null);
  const close = () => setMenu(null);
  const toggleMenu = (next: Exclude<OpenMenu, null>) => setMenu((current) => (current === next ? null : next));
  const categories = memoryCategoriesOf(lesson);
  const row = cardsEnabled ? memoryRowCards(lesson, cards) : { every: false, cards: [] };
  const addable = cardsEnabled ? addableCards(lesson, cards) : [];
  const filterPart = (layer: MemoryFilterLayer, value: string, label: string) => (
    <button type="button" className="mo-part" onClick={() => onToggleFilter(layer, value)}>
      {label}
    </button>
  );
  const categoryChip = (category: MemoryCategory, menuButton?: ReactNode) => (
    <span key={category} data-memory-label="category" data-memory-category={category} className="mo-chip">
      {filterPart('category', category, memoryCategoryLabel(category) ?? '')}
      {menuButton}
    </span>
  );

  // Single choice (older servers): pick one category; the menu closes.
  const radioItems = () => categoryChoices(lesson).map((choice) => (
    <button
      key={choice}
      type="button"
      role="menuitemradio"
      aria-checked={choice === categories[0]}
      onClick={() => {
        close();
        if (choice !== categories[0]) onChangeCategory(choice);
      }}
    >
      <span className="mo-check">{choice === categories[0] ? <Check aria-hidden="true" /> : null}</span>
      {memoryCategoryLabel(choice)}
    </button>
  ));
  // Checklist (`memoryVersion` 4): each tick saves at once and the menu stays open.
  const checkItems = () => categoryChecklist(lesson).map(({ category, checked, disabled }) => (
    <button
      key={category}
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled || busy}
      onClick={() => {
        const next = toggleMemoryCategory(categories, category);
        if (next) onChangeCategories?.(next);
      }}
    >
      <span className="mo-check">{checked ? <Check aria-hidden="true" /> : null}</span>
      {memoryCategoryLabel(category)}
    </button>
  ));

  const leading = categories.slice(0, -1);
  const last = categories.length > 0 ? categories[categories.length - 1] : undefined;
  // The chevron sits on the last category chip and opens the menu for all of them.
  const lastLabel = last === undefined ? null : categoryEditable ? (
    <MenuWrap
      key="category-menu"
      open={menu === 'category'}
      onClose={close}
      trigger={categoryChip(last, (
        <button
          type="button"
          className="mo-icon"
          aria-label={multiCategory ? 'Change categories' : 'Change category'}
          aria-haspopup="menu"
          aria-expanded={menu === 'category'}
          disabled={busy && menu !== 'category'}
          onClick={() => toggleMenu('category')}
        >
          <ChevronDown aria-hidden="true" strokeWidth={2.4} />
        </button>
      ))}
    >
      {multiCategory ? checkItems() : radioItems()}
    </MenuWrap>
  ) : categoryChip(last);

  return (
    <span className="mo-labels" data-memory-labels="">
      {leading.map((category) => categoryChip(category))}
      {lastLabel}
      {row.every ? (
        <span data-memory-label="every" className="mo-chip is-card">
          {filterPart('card', EVERY_CARD, 'Every card')}
        </span>
      ) : null}
      {row.cards.map((card) => (
        <span key={card.profileId} data-memory-label="card" data-profile-id={card.profileId} className="mo-chip is-card">
          {filterPart('card', card.profileId, cardLabel(card))}
          <button type="button" className="mo-icon" aria-label={`Remove from ${cardLabel(card)}`} disabled={busy} onClick={() => onRemoveCard(card.profileId)}>
            <X aria-hidden="true" strokeWidth={2.4} />
          </button>
        </span>
      ))}
      {addable.length > 0 ? (
        <MenuWrap
          open={menu === 'card'}
          onClose={close}
          trigger={(
            <button
              type="button"
              data-memory-label="add-card"
              className="mo-chip is-add"
              aria-haspopup="menu"
              aria-expanded={menu === 'card'}
              disabled={busy}
              onClick={() => toggleMenu('card')}
            >
              + Card
            </button>
          )}
        >
          {addable.map((card) => (
            <button
              key={card.profileId}
              type="button"
              role="menuitemcheckbox"
              aria-checked={false}
              onClick={() => {
                close();
                onAddCard(card.profileId);
              }}
            >
              <span className="mo-check" />
              {cardLabel(card)}
            </button>
          ))}
        </MenuWrap>
      ) : null}
      <button
        type="button"
        data-memory-label="from"
        className="mo-chip is-from"
        onClick={() => onToggleFilter('from', origin.key)}
      >
        {origin.label}
      </button>
    </span>
  );
}
