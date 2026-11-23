// Shared app state. Modules register their functions on `app` at startup.
export const app = {
  api: null,
  ws: null,
  jobs: null,
  me: null,
  authSource: null,
  guilds: [],
  dms: [],
  relationships: [],
  channels: new Map(),        // id -> channel (guild channels, threads, DMs)
  guildChannels: new Map(),   // guildId -> channel[]
  threadsByParent: new Map(), // parentId -> thread[]
  roles: new Map(),           // guildId -> Map(roleId -> role)
  members: new Map(),         // `${guildId}:${userId}` -> member | null
  conv: null,                 // current conversation meta
  messages: [],               // current conversation, oldest -> newest
  view: [],                   // after filters
  selected: new Set(),
  page: 0,
  filters: { text: '', regex: false, author: '', attachment: '', after: '', before: '', categories: [], inverse: false, channel: '' },
  pkg: null,
  sidebar: { tab: 'chats', guildId: '@me', checked: new Set(), pkgChecked: new Set(), filter: '' },
  logLines: [],
};
