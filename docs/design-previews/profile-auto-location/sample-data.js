// Sample data only: a synthetic person, two sample device places and a short
// zone list. Nothing here is read from or sent to a server.
window.PREVIEW_DATA = {
  person: {
    name: 'Maya',
    handle: 'maya',
    email: 'maya@example.com',
    about: 'Design and research at a small studio. Weekend climber.',
    birthdayMac: '03/04/1996',
    birthdayIos: 'March 4, 1996',
  },
  // Where the sample device is. "Travel" switches between them so automatic
  // fields follow the device and manual ones stay put.
  places: {
    paloalto: { city: 'Palo Alto, CA', zone: 'America/Los_Angeles', clock: '9:41 AM' },
    thuwal: { city: 'Thuwal, Saudi Arabia', zone: 'Asia/Riyadh', clock: '8:41 PM' },
  },
  // Labels follow timeZoneOptions() in app/desktop/src/pages/cloudProfileDraft.ts.
  zones: [
    { id: 'America/Los_Angeles', label: 'Pacific Time (Los Angeles), GMT-8', short: 'Pacific Time, GMT-8' },
    { id: 'America/New_York', label: 'Eastern Time (New York), GMT-5', short: 'Eastern Time, GMT-5' },
    { id: 'Europe/London', label: 'Greenwich Mean Time (London), GMT+0', short: 'Greenwich Mean Time, GMT+0' },
    { id: 'Europe/Berlin', label: 'Central European Time (Berlin), GMT+1', short: 'Central European Time, GMT+1' },
    { id: 'Asia/Riyadh', label: 'Arabian Time (Riyadh), GMT+3', short: 'Arabian Time, GMT+3' },
    { id: 'Asia/Tokyo', label: 'Japan Time, GMT+9', short: 'Japan Time, GMT+9' },
  ],
  // `location: null` with automatic mode means "the device's current city".
  states: {
    auto: {
      timeZone: { mode: 'automatic', value: null },
      location: { mode: 'automatic', value: null },
      permission: 'granted',
    },
    manual: {
      timeZone: { mode: 'manual', value: 'America/New_York' },
      location: { mode: 'manual', value: 'Bay Area' },
      permission: 'granted',
    },
    denied: {
      timeZone: { mode: 'automatic', value: null },
      location: { mode: 'automatic', value: 'Palo Alto, CA' },
      permission: 'denied',
    },
    empty: {
      timeZone: { mode: 'automatic', value: null },
      location: { mode: 'manual', value: '' },
      permission: 'notDetermined',
    },
  },
};
