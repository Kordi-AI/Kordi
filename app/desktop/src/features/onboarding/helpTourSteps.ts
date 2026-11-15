import type { CloudAccountSettingsTabId } from '@/pages/cloudAccountSettingsNav';
import type { NavId } from '@/kordi-app/types';
import type { HelpGroundingScreen } from './helpNavigation';

export type HelpTourStep = {
  target: string;
  section?: string;
  title: string;
  body: string;
  page?: NavId;
  settings?: CloudAccountSettingsTabId;
  groundingScreen?: HelpGroundingScreen;
  /** Explains a control only the desktop app has, such as reading local files. */
  desktopOnly?: true;
  /** A source this account may not offer; once its screen shows without it, the tour moves on sooner. */
  optional?: true;
  /** Replaces `body` in the browser app when the desktop wording does not apply. */
  browserBody?: string;
};

// The nav rail, top to bottom.
const tabSteps: readonly HelpTourStep[] = [
  { target: 'nav-contacts', page: 'contacts', title: 'Contacts: people you know', body: 'Your contacts are listed here. Use the add-person button above the list to find or invite someone. Grounding, at the top of the list, is where you meet new people.' },
  { target: 'nav-chats', page: 'chats', title: 'Chats: talk with people', body: 'Conversations with people and groups are here. Click + to start a chat or a group, then send a message or attach a file.' },
  { target: 'nav-agent-chats', page: 'agent-chats', title: 'Agent Chats: work with your agents', body: 'Conversations with your own agents are here. Start a chat, choose an agent, and ask it to do something for you.' },
  { target: 'nav-agents', page: 'agents', title: 'Factory: build your agents', body: 'Create or edit an agent here. Choose its model, instructions, and tools. Then talk to it in Agent Chats.' },
  { target: 'nav-digest', page: 'digest', title: 'Digest: your daily overview', body: 'Review recent activity and upcoming calendar events here.' },
];
const setUpSteps: readonly HelpTourStep[] = [
  { target: 'settings-auth', settings: 'auth', title: 'Connect an AI account', body: 'Choose a provider here, then sign in or add its API key. This lets your agents use that provider’s models.' },
];
// The Mac finds agent files on this computer; the browser app imports files the person chooses.
const importSteps: readonly HelpTourStep[] = [
  { target: 'settings-memory', settings: 'memory', title: 'Bring your existing knowledge into Kordi', body: 'Open Memory in settings to import instructions and memories from your coding agents. Turn on Memory to show the Import section.',
    browserBody: 'Open Memory in settings to import instruction or memory files from your coding agents. Turn on Memory to show the Import section.' },
  { target: 'memory-import-files', settings: 'memory', title: 'Choose the files to import', body: 'Review the detected files or click Choose files to add your own. Select only the files you want Kordi to read.',
    browserBody: 'Click Choose files to add Markdown, text, or JSON files from your computer. Select only the files you want Kordi to read.' },
  { target: 'memory-import-run', settings: 'memory', title: 'Import the selected files', body: 'Click Import when you are ready. Kordi extracts memories from the selected files; you can review and remove them in Memory.' },
  { target: 'memory-review', settings: 'memory', title: 'Review what was imported', body: 'Find the imported memories here. Search, edit, or remove anything you do not want Kordi to remember. Next, use them to build your card.' },
];
const cardSteps: readonly HelpTourStep[] = [
  { target: 'grounding', page: 'contacts', title: 'Open Grounding', body: 'Grounding is at the top of Contacts. It holds your cards: short summaries of what you work on and what you are looking for, used to match you with other people.' },
  { target: 'grounding-cards', groundingScreen: 'home', title: 'Keep different sides of you in separate cards', body: 'Select a card here to work on it. Each card has its own topics, sources, and sharing settings.' },
  { target: 'grounding-new-card', groundingScreen: 'home', title: 'Add a card', body: 'Click New card to choose a type and give it a name. Creating a card does not automatically share it.' },
];
// One step per source group, in the order the Build screen shows them.
const buildSteps: readonly HelpTourStep[] = [
  { target: 'grounding-memory', groundingScreen: 'build', optional: true, title: 'Start from your Kordi memory', body: 'Turn on Memory to build this card from what Kordi remembers about you, such as memories from the files you imported.' },
  { target: 'grounding-documents', groundingScreen: 'build', title: 'Choose documents for this card', body: 'Open this list to select Kordi documents. Only the documents you select are included in this build.' },
  { target: 'grounding-connectors', groundingScreen: 'build', optional: true, title: 'Add your connected accounts', body: 'Include Gmail, Google Calendar, GitHub, or Slack. Click Set up to connect an account, then switch it on for this card.' },
  { target: 'grounding-device', groundingScreen: 'build', optional: true, desktopOnly: true, title: 'Add sources from this Mac', body: 'Allow Calendar or Reminders to add event and reminder titles. Agents adds the instruction and memory files of coding agents on this Mac.' },
  { target: 'grounding-links', groundingScreen: 'build', title: 'Add links about you', body: 'Paste your homepage, profiles, or papers. Kordi reads public pages; a page that needs sign-in cannot be read.' },
  { target: 'grounding-notes', groundingScreen: 'build', title: 'Write what the sources miss', body: 'Say in your own words what you do, what interests you, and what you are looking for.' },
  { target: 'grounding-build', groundingScreen: 'build', title: 'Build the card', body: 'Click Build when at least one source is on. Kordi turns your sources into the topics on your card.' },
];
const reviewSteps: readonly HelpTourStep[] = [
  { target: 'grounding-topics', groundingScreen: 'card', title: 'Review what your card says', body: 'Review the topics and their sources. Edit or hide anything you do not want on the card before sharing.' },
  { target: 'grounding-sharing', groundingScreen: 'card', title: 'Decide whether to share this card', body: 'Use Share my card to control sharing. Turn it on when you are ready to use this card in Grounding.' },
];
const meetSteps: readonly HelpTourStep[] = [
  { target: 'grounding-pair', groundingScreen: 'home', title: 'Pair with one person', body: 'Back on the Grounding page, click Pair to show your code, or enter theirs. Kordi compares the two cards and shows what you have in common.' },
  { target: 'grounding-room', groundingScreen: 'home', title: 'Join a room with a code', body: 'At an event, type the four-digit room code and click Enter pair room. Click Create to start your own room and share its code.' },
  { target: 'grounding-room-people', groundingScreen: 'room', title: 'See who is in the room', body: 'Everyone in the room is listed with a match score. Click a person to see what you have in common. Add each other as contacts to start a chat.' },
  { target: 'grounding-room-topics', groundingScreen: 'room', title: 'Find people by topic', body: 'Switch to Topics to see what the room shares. Click Start on a topic to start a group with the people who share it.' },
];
// Ways to take your work out of Kordi or show it to others.
const shareSteps: readonly HelpTourStep[] = [
  { target: 'chat-export', page: 'chats', title: 'Export a session', body: 'Right-click a chat here or in Agent Chats and choose Export. Kordi saves the whole session, including agent steps, as one file.',
    browserBody: 'Right-click a chat here or in Agent Chats and choose Export. The whole session, including agent steps, downloads as one file.' },
];
const helpSteps: readonly HelpTourStep[] = [
  { target: 'help', title: 'Find help here anytime', body: 'Click ? to replay this tour. Choose Permissions & access to enable your microphone, camera, notifications, or calendar.',
    browserBody: 'Click ? to replay this tour. Choose Permissions & access to allow notifications, your microphone, or your camera in this browser.' },
];

// One walkthrough, with short sections and direct entry points in Help.
const section = (name: string, steps: readonly HelpTourStep[]) => steps.map((step) => ({ ...step, section: name }));
export const helpTourSteps: readonly HelpTourStep[] = [
  ...section('Tabs', tabSteps),
  ...section('Set up', setUpSteps),
  ...section('Import memory', importSteps),
  ...section('Cards', cardSteps),
  ...section('Build a card', buildSteps),
  ...section('Review and share', reviewSteps),
  ...section('Meet people', meetSteps),
  ...section('Share your work', shareSteps),
  ...section('Help', helpSteps),
];

export type HelpTourId = 'workspace' | 'grounding' | 'cards' | 'imports';
/** The walkthrough and the parts of it Help can jump to on their own. */
export const helpTours: Record<HelpTourId, readonly HelpTourStep[]> = {
  workspace: helpTourSteps,
  imports: importSteps,
  cards: [...cardSteps, ...buildSteps, ...reviewSteps],
  grounding: meetSteps,
};
export const helpTourEntry: Record<HelpTourId, string> = { workspace: 'nav-contacts', imports: 'settings-memory', cards: 'grounding', grounding: 'grounding-pair' };

/** Whether this runtime can show the step. A hidden step keeps its saved index. */
export function helpTourStepAvailable(step: HelpTourStep, browserApp: boolean) {
  return !(browserApp && step.desktopOnly);
}

export function helpTourStepBody(step: HelpTourStep, browserApp: boolean) {
  return browserApp && step.browserBody ? step.browserBody : step.body;
}

export function helpTourAvailable(id: HelpTourId, browserApp: boolean) {
  return helpTours[id].some((step) => helpTourStepAvailable(step, browserApp));
}
