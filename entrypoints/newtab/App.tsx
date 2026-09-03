import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  Eraser,
  ExternalLink,
  Folder as FolderIcon,
  History,
  MoreHorizontal,
  PanelsTopLeft,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';

type SavedItem = { id: string; title: string; url: string; faviconUrl?: string; createdAt: string; lastAccessedAt?: string };
type Folder = { id: string; title: string; color: string; spaceId: string; collapsed?: boolean; archived?: boolean; items: SavedItem[] };
type Space = { id: string; title: string };
type Theme = 'light' | 'dark' | 'auto';
type BoardState = { spaces: Space[]; folders: Folder[]; activeSpace: string; theme: Theme; showUnusedBookmarks: boolean; sidebarWidth: number; faviconRefreshRevision: number };
type OpenTab = { id?: number; windowId?: number; title: string; url: string; faviconUrl?: string; pinned?: boolean; active?: boolean };
type RecentTab = { id?: string; title: string; url: string };
type EditingItem = { folderId: string; itemId: string; title: string; url: string; originalTitle: string; originalUrl: string; x: number; y: number };
type ToastState = { message: string; undo?: () => void };
type InlineBookmarkEdit = { folderId: string; itemId: string; draft: string };
type InlineFolderEdit = { folderId: string; draft: string };
type InlineSpaceEdit = { spaceId: string; draft: string };
type DropTarget = { folderId: string; itemId?: string; position: 'before' | 'after' | 'end' };
type TabmeImportResult = { board: BoardState; foldersAdded: number; bookmarksAdded: number; duplicatesSkipped: number; groupsConverted: number };
type BrowserBookmarkNode = { id: string; title: string; url?: string; dateAdded?: number; children?: BrowserBookmarkNode[] };
type BrowserBookmarkImportResult = { board: BoardState; foldersAdded: number; bookmarksAdded: number; duplicatesSkipped: number };

const COLORS = ['#9bdddc', '#a8e89d', '#bea0ef', '#93c6ee', '#e25b64', '#f3d36a', '#f1ad58', '#ef8ec3'];
const UNUSED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'tabloom-board-v1';
const SEEDED_FOLDER_IDS = new Set(['quickspace', 'daily-tools', 'research', 'projects', 'weekend', 'northstar']);
const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const now = () => new Date().toISOString();
const domainFromUrl = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, '') || 'Local file'; }
  catch { return 'Saved link'; }
};

const DEFAULT_STATE: BoardState = {
  activeSpace: 'home',
  theme: 'dark',
  showUnusedBookmarks: false,
  sidebarWidth: 350,
  faviconRefreshRevision: 0,
  spaces: [{ id: 'home', title: 'Home' }],
  folders: [],
};

const SAMPLE_TABS: OpenTab[] = [];

function normalizeBoard(value: unknown): BoardState | null {
  const candidate = value as Partial<BoardState> | null;
  if (!candidate || !Array.isArray(candidate.spaces) || !Array.isArray(candidate.folders)) return null;
  const folders = candidate.folders.filter((folder) => !SEEDED_FOLDER_IDS.has(folder.id));
  const occupiedSpaces = new Set(folders.map((folder) => folder.spaceId));
  const spaces = candidate.spaces.filter((space) => !['personal', 'work'].includes(space.id) || occupiedSpaces.has(space.id));
  if (!spaces.some((space) => space.id === 'home')) spaces.unshift({ id: 'home', title: 'Home' });
  const requestedActiveSpace = candidate.activeSpace || 'home';
  return {
    spaces,
    folders,
    activeSpace: spaces.some((space) => space.id === requestedActiveSpace) ? requestedActiveSpace : spaces[0]!.id,
    theme: candidate.theme === 'light' || candidate.theme === 'dark' || candidate.theme === 'auto' ? candidate.theme : 'dark',
    showUnusedBookmarks: candidate.showUnusedBookmarks === true,
    sidebarWidth: typeof candidate.sidebarWidth === 'number' ? Math.min(520, Math.max(260, candidate.sidebarWidth)) : 350,
    faviconRefreshRevision: typeof candidate.faviconRefreshRevision === 'number' ? candidate.faviconRefreshRevision : 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unwrapTabmeUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/suspended.html')) {
      const originalUrl = new URLSearchParams(parsed.hash.slice(1)).get('uri');
      if (originalUrl) return originalUrl;
    }
  } catch {
    // Keep unusual URLs such as chrome:// and file:// entries unchanged.
  }
  return url;
}

function mergeTabmeExport(current: BoardState, value: unknown): TabmeImportResult {
  if (!isRecord(value) || value.isTabme !== true || !Array.isArray(value.spaces)) throw new Error('Not a Tabme export');

  const spaces = [...current.spaces];
  const folders = current.folders.map((folder) => ({ ...folder, items: [...folder.items] }));
  let firstImportedSpaceId: string | null = null;
  let foldersAdded = 0;
  let bookmarksAdded = 0;
  let duplicatesSkipped = 0;
  let groupsConverted = 0;

  const ensureSpace = (title: string) => {
    const existing = spaces.find((space) => space.title.toLowerCase() === title.toLowerCase());
    if (existing) return existing.id;
    const id = makeId();
    spaces.push({ id, title });
    return id;
  };

  const toBookmark = (item: unknown): SavedItem | null => {
    if (!isRecord(item) || typeof item.url !== 'string' || !item.url.trim()) return null;
    const url = unwrapTabmeUrl(item.url.trim());
    const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : domainFromUrl(url);
    const rawFavicon = typeof item.favIconUrl === 'string' ? item.favIconUrl.trim() : '';
    const faviconUrl = rawFavicon.startsWith('data:image/') || /^https?:\/\//i.test(rawFavicon) ? rawFavicon : undefined;
    return { id: makeId(), title, url, faviconUrl, createdAt: now() };
  };

  const mergeFolder = (spaceId: string, title: string, color: string, collapsed: boolean, rawItems: unknown[]) => {
    let folder = folders.find((candidate) => candidate.spaceId === spaceId && candidate.title.toLowerCase() === title.toLowerCase());
    if (!folder) {
      folder = { id: makeId(), title, color, spaceId, collapsed, items: [] };
      folders.push(folder);
      foldersAdded += 1;
    } else {
      folder.color = color;
      folder.collapsed = collapsed;
    }
    const existingUrls = new Set(folder.items.map((item) => item.url));
    rawItems.forEach((rawItem) => {
      const bookmark = toBookmark(rawItem);
      if (!bookmark) return;
      if (existingUrls.has(bookmark.url)) {
        duplicatesSkipped += 1;
        return;
      }
      folder!.items.push(bookmark);
      existingUrls.add(bookmark.url);
      bookmarksAdded += 1;
    });
  };

  value.spaces.forEach((rawSpace, spaceIndex) => {
    if (!isRecord(rawSpace) || !Array.isArray(rawSpace.folders)) return;
    const spaceTitle = typeof rawSpace.title === 'string' && rawSpace.title.trim() ? rawSpace.title.trim() : `Tabme space ${spaceIndex + 1}`;
    const spaceId = ensureSpace(spaceTitle);
    if (!firstImportedSpaceId) firstImportedSpaceId = spaceId;

    rawSpace.folders.forEach((rawFolder, folderIndex) => {
      if (!isRecord(rawFolder)) return;
      const folderTitle = typeof rawFolder.title === 'string' && rawFolder.title.trim() ? rawFolder.title.trim() : `Imported folder ${folderIndex + 1}`;
      const color = typeof rawFolder.color === 'string' && /^#[0-9a-f]{6}$/i.test(rawFolder.color) ? rawFolder.color : COLORS[folderIndex % COLORS.length]!;
      const collapsed = rawFolder.collapsed === true;
      const rawItems = Array.isArray(rawFolder.items) ? rawFolder.items : [];
      const directBookmarks: unknown[] = [];
      const groups: Record<string, unknown>[] = [];

      rawItems.forEach((rawItem) => {
        if (isRecord(rawItem) && (rawItem.type === 'group' || rawItem.objectType === 'group') && Array.isArray(rawItem.groupItems)) groups.push(rawItem);
        else directBookmarks.push(rawItem);
      });

      if (directBookmarks.length || !groups.length) mergeFolder(spaceId, folderTitle, color, collapsed, directBookmarks);
      groups.forEach((group, groupIndex) => {
        const groupTitle = typeof group.title === 'string' && group.title.trim() ? group.title.trim() : `Group ${groupIndex + 1}`;
        mergeFolder(spaceId, `${folderTitle} · ${groupTitle}`, color, group.collapsed === true, group.groupItems as unknown[]);
        groupsConverted += 1;
      });
    });
  });

  if (!firstImportedSpaceId) throw new Error('The Tabme export contains no spaces');
  return {
    board: { ...current, spaces, folders, activeSpace: firstImportedSpaceId },
    foldersAdded,
    bookmarksAdded,
    duplicatesSkipped,
    groupsConverted,
  };
}

function mergeBrowserBookmarkTree(current: BoardState, roots: BrowserBookmarkNode[]): BrowserBookmarkImportResult {
  const folders = current.folders.map((folder) => ({ ...folder, items: [...folder.items] }));
  let foldersAdded = 0;
  let bookmarksAdded = 0;
  let duplicatesSkipped = 0;

  const mergeFolder = (title: string, nodes: BrowserBookmarkNode[]) => {
    let folder = folders.find((candidate) => candidate.spaceId === current.activeSpace && candidate.title.toLowerCase() === title.toLowerCase());
    if (!folder) {
      folder = { id: makeId(), title, color: COLORS[folders.length % COLORS.length]!, spaceId: current.activeSpace, items: [] };
      folders.push(folder);
      foldersAdded += 1;
    }
    const existingUrls = new Set(folder.items.map((item) => item.url));
    nodes.forEach((node) => {
      if (!node.url) return;
      if (existingUrls.has(node.url)) {
        duplicatesSkipped += 1;
        return;
      }
      const createdAt = typeof node.dateAdded === 'number' && Number.isFinite(node.dateAdded) ? new Date(node.dateAdded).toISOString() : now();
      folder!.items.push({ id: makeId(), title: node.title.trim() || domainFromUrl(node.url), url: node.url, createdAt });
      existingUrls.add(node.url);
      bookmarksAdded += 1;
    });
  };

  const visit = (node: BrowserBookmarkNode, parentPath: string[]) => {
    if (node.url) return;
    const isRoot = !node.title.trim() && parentPath.length === 0;
    const path = isRoot ? parentPath : [...parentPath, node.title.trim() || 'Untitled folder'];
    const children = Array.isArray(node.children) ? node.children : [];
    const directBookmarks = children.filter((child) => typeof child.url === 'string');
    const childFolders = children.filter((child) => !child.url);
    if (directBookmarks.length || (!isRoot && !childFolders.length)) mergeFolder(path.join(' · ') || 'Browser bookmarks', directBookmarks);
    childFolders.forEach((child) => visit(child, path));
  };

  roots.forEach((root) => visit(root, []));
  return { board: { ...current, folders }, foldersAdded, bookmarksAdded, duplicatesSkipped };
}

async function loadBoard(): Promise<BoardState | null> {
  try {
    if (typeof browser !== 'undefined' && browser.storage?.local) {
      const stored = await browser.storage.local.get(STORAGE_KEY);
      return normalizeBoard(stored[STORAGE_KEY]);
    }
  } catch { /* Web preview fallback. */ }
  try { const value = localStorage.getItem(STORAGE_KEY); return value ? normalizeBoard(JSON.parse(value)) : null; }
  catch { return null; }
}

async function saveBoard(board: BoardState) {
  try {
    if (typeof browser !== 'undefined' && browser.storage?.local) { await browser.storage.local.set({ [STORAGE_KEY]: board }); return; }
  } catch { /* Web preview fallback. */ }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(board));
}

function Favicon({ tab, index = 0, refreshKey = 0 }: { tab: { title: string; faviconUrl?: string; url?: string }; index?: number; refreshKey?: number }) {
  const [sourceIndex, setSourceIndex] = useState(0);
  useEffect(() => setSourceIndex(0), [tab.faviconUrl, tab.url, refreshKey]);
  const sources: string[] = [];
  if (tab.faviconUrl) sources.push(tab.faviconUrl);
  if (tab.url && typeof browser !== 'undefined') {
    const extensionRoot = browser.runtime.getURL('/newtab.html').replace(/\/newtab\.html$/, '');
    sources.push(`${extensionRoot}/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32&v=${refreshKey}`);
  }
  const faviconUrl = sources[sourceIndex];
  if (faviconUrl) return <img className="favicon favicon-image" src={faviconUrl} alt="" onError={() => setSourceIndex((current) => current + 1)} />;
  return <span className={`favicon tone-${index % 6}`}>{(domainFromUrl(tab.url ?? '').charAt(0) || tab.title.charAt(0)).toUpperCase()}</span>;
}

export default function App() {
  const [board, setBoard] = useState<BoardState>(DEFAULT_STATE);
  const [hydrated, setHydrated] = useState(false);
  const [openTabs, setOpenTabs] = useState<OpenTab[]>(SAMPLE_TABS);
  const [recentTabs, setRecentTabs] = useState<RecentTab[]>([]);
  const [query, setQuery] = useState('');
  const [recentOpen, setRecentOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [folderMenu, setFolderMenu] = useState<string | null>(null);
  const [spaceMenu, setSpaceMenu] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<EditingItem | null>(null);
  const [inlineBookmarkEdit, setInlineBookmarkEdit] = useState<InlineBookmarkEdit | null>(null);
  const [inlineFolderEdit, setInlineFolderEdit] = useState<InlineFolderEdit | null>(null);
  const [inlineSpaceEdit, setInlineSpaceEdit] = useState<InlineSpaceEdit | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [draggedFolder, setDraggedFolder] = useState<string | null>(null);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const tabmeImportRef = useRef<HTMLInputElement>(null);
  const openTimerRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const folderClickTimerRef = useRef<number | null>(null);
  const didDragFolderRef = useRef(false);

  const notify = (message: string, undo?: () => void) => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ message, undo });
    toastTimerRef.current = window.setTimeout(() => setToast(null), undo ? 5200 : 2600);
  };

  const refreshTabs = async () => {
    try {
      if (typeof browser === 'undefined' || !browser.tabs) return;
      const tabs = await browser.tabs.query({ currentWindow: true });
      setOpenTabs(tabs.filter((tab) => !tab.url?.startsWith(browser.runtime.getURL('/newtab.html'))).map((tab) => ({
        id: tab.id, windowId: tab.windowId, title: tab.title || 'Untitled tab', url: tab.url || '', faviconUrl: tab.favIconUrl, pinned: tab.pinned, active: tab.active,
      })));
    } catch { /* Keep representative tabs in a normal browser preview. */ }
  };

  const refreshRecent = async () => {
    try {
      if (typeof browser === 'undefined' || !browser.sessions) return;
      const sessions = await browser.sessions.getRecentlyClosed({ maxResults: 10 });
      setRecentTabs(sessions.flatMap((session) => {
        if (session.tab?.url) return [{ id: session.tab.sessionId, title: session.tab.title || 'Closed tab', url: session.tab.url }];
        return session.window?.tabs?.filter((tab) => tab.url).map((tab) => ({ id: tab.sessionId, title: tab.title || 'Closed tab', url: tab.url! })) ?? [];
      }));
    } catch { setRecentTabs([]); }
  };

  useEffect(() => {
    loadBoard().then((saved) => { if (saved?.folders && saved?.spaces) setBoard(saved); setHydrated(true); });
    refreshTabs(); refreshRecent();
    if (typeof browser === 'undefined' || !browser.tabs) return;
    const update = () => refreshTabs();
    browser.tabs.onCreated.addListener(update); browser.tabs.onRemoved.addListener(update); browser.tabs.onUpdated.addListener(update);
    return () => { browser.tabs.onCreated.removeListener(update); browser.tabs.onRemoved.removeListener(update); browser.tabs.onUpdated.removeListener(update); };
  }, []);

  useEffect(() => { if (hydrated) saveBoard(board); }, [board, hydrated]);
  useEffect(() => { document.documentElement.dataset.theme = board.theme; }, [board.theme]);
  useEffect(() => {
    if (!isResizingSidebar) return;
    const resize = (event: PointerEvent) => setBoard((current) => ({ ...current, sidebarWidth: Math.min(520, Math.max(260, event.clientX)) }));
    const finish = () => setIsResizingSidebar(false);
    window.addEventListener('pointermove', resize);
    window.addEventListener('pointerup', finish, { once: true });
    return () => { window.removeEventListener('pointermove', resize); window.removeEventListener('pointerup', finish); };
  }, [isResizingSidebar]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && ['k', 'f'].includes(event.key.toLowerCase())) { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key === 'Escape') { setFolderMenu(null); setSpaceMenu(null); setRecentOpen(false); setSettingsOpen(false); setEditingItem(null); setInlineBookmarkEdit(null); setInlineFolderEdit(null); setInlineSpaceEdit(null); }
    };
    window.addEventListener('keydown', handleKey); return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleTabs = useMemo(() => openTabs.filter((tab) => !normalizedQuery || `${tab.title} ${tab.url}`.toLowerCase().includes(normalizedQuery)), [openTabs, normalizedQuery]);
  const visibleFolders = useMemo(() => board.folders.filter((folder) => folder.spaceId === board.activeSpace && !folder.archived && (!normalizedQuery || `${folder.title} ${folder.items.map((item) => `${item.title} ${item.url}`).join(' ')}`.toLowerCase().includes(normalizedQuery))), [board, normalizedQuery]);
  const duplicateIds = useMemo(() => {
    const seen = new Set<string>(); const duplicates: number[] = [];
    openTabs.forEach((tab) => { const key = tab.url.replace(/\/$/, '').toLowerCase(); if (key && seen.has(key) && tab.id != null) duplicates.push(tab.id); else if (key) seen.add(key); });
    return duplicates;
  }, [openTabs]);

  const openUrl = async (url: string, newTab = false) => {
    try {
      if (typeof browser !== 'undefined' && browser.tabs) {
        if (newTab) await browser.tabs.create({ url, active: false });
        else {
          const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
          if (activeTab?.id != null) await browser.tabs.update(activeTab.id, { url });
          else await browser.tabs.create({ url });
        }
      } else if (newTab) window.open(url, '_blank', 'noopener,noreferrer');
      else window.location.assign(url);
    }
    catch { notify('This link could not be opened'); }
  };
  const activateTab = async (tab: OpenTab) => {
    if (tab.id == null || typeof browser === 'undefined') return openUrl(tab.url);
    await browser.tabs.update(tab.id, { active: true }); if (tab.windowId != null) await browser.windows.update(tab.windowId, { focused: true });
  };
  const closeTab = async (tab: OpenTab) => {
    if (tab.id == null || typeof browser === 'undefined') { setOpenTabs((current) => current.filter((item) => item !== tab)); return; }
    await browser.tabs.remove(tab.id); refreshTabs();
  };

  const addFolder = () => {
    const id = makeId();
    setBoard((current) => ({ ...current, folders: [...current.folders, { id, title: 'Untitled folder', color: COLORS[current.folders.length % COLORS.length]!, spaceId: current.activeSpace, items: [] }] }));
    setInlineFolderEdit({ folderId: id, draft: 'Untitled folder' });
  };
  const addSpace = () => {
    const id = makeId();
    setBoard((current) => ({ ...current, activeSpace: id, spaces: [...current.spaces, { id, title: `Space ${current.spaces.length + 1}` }] }));
    setInlineSpaceEdit({ spaceId: id, draft: `Space ${board.spaces.length + 1}` });
  };
  const queueOpenBookmark = (url: string, newTab = false) => {
    if (openTimerRef.current) window.clearTimeout(openTimerRef.current);
    openTimerRef.current = window.setTimeout(() => openUrl(url, newTab), 220);
  };

  const editBookmark = (folderId: string, item: SavedItem, trigger: HTMLElement) => {
    if (openTimerRef.current) window.clearTimeout(openTimerRef.current);
    const rect = trigger.getBoundingClientRect();
    const width = 370;
    const height = 250;
    setFolderMenu(null);
    setSettingsOpen(false);
    setEditingItem({
      folderId,
      itemId: item.id,
      title: item.title,
      url: item.url,
      originalTitle: item.title,
      originalUrl: item.url,
      x: Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width)),
      y: Math.max(12, Math.min(window.innerHeight - height - 12, rect.bottom + 7)),
    });
  };

  const saveEditedBookmark = (close = false) => {
    if (!editingItem || !editingItem.title.trim() || !editingItem.url.trim()) return;
    const title = editingItem.title.trim();
    const url = editingItem.url.trim();
    const changed = title !== editingItem.originalTitle || url !== editingItem.originalUrl;
    if (!changed) { if (close) setEditingItem(null); return; }
    const previousTitle = editingItem.originalTitle;
    const previousUrl = editingItem.originalUrl;
    const folderId = editingItem.folderId;
    const itemId = editingItem.itemId;
    setBoard((current) => ({
      ...current,
      folders: current.folders.map((folder) => folder.id === folderId
        ? { ...folder, items: folder.items.map((item) => item.id === itemId ? { ...item, title, url } : item) }
        : folder),
    }));
    if (close) setEditingItem(null);
    else setEditingItem((current) => current ? { ...current, title, url, originalTitle: title, originalUrl: url } : null);
    notify('Bookmark updated', () => setBoard((current) => ({
      ...current,
      folders: current.folders.map((folder) => folder.id === folderId
        ? { ...folder, items: folder.items.map((item) => item.id === itemId ? { ...item, title: previousTitle, url: previousUrl } : item) }
        : folder),
    })));
  };

  const copyEditedUrl = async () => {
    if (!editingItem) return;
    try { await navigator.clipboard.writeText(editingItem.url); notify('URL copied'); }
    catch { notify('Could not copy the URL'); }
  };

  const startInlineBookmarkEdit = (folderId: string, item: SavedItem) => {
    if (openTimerRef.current) window.clearTimeout(openTimerRef.current);
    setInlineBookmarkEdit({ folderId, itemId: item.id, draft: item.title });
  };

  const saveInlineBookmarkEdit = () => {
    if (!inlineBookmarkEdit) return;
    const title = inlineBookmarkEdit.draft.trim();
    const folderId = inlineBookmarkEdit.folderId;
    const itemId = inlineBookmarkEdit.itemId;
    const previousTitle = board.folders.find((folder) => folder.id === folderId)?.items.find((item) => item.id === itemId)?.title;
    if (title && previousTitle && title !== previousTitle) {
      setBoard((current) => ({
        ...current,
        folders: current.folders.map((folder) => folder.id === folderId
          ? { ...folder, items: folder.items.map((item) => item.id === itemId ? { ...item, title } : item) }
          : folder),
      }));
      notify('Bookmark renamed', () => setBoard((current) => ({
        ...current,
        folders: current.folders.map((folder) => folder.id === folderId
          ? { ...folder, items: folder.items.map((item) => item.id === itemId ? { ...item, title: previousTitle } : item) }
          : folder),
      })));
    }
    setInlineBookmarkEdit(null);
  };

  const saveInlineFolderEdit = () => {
    if (!inlineFolderEdit) return;
    const title = inlineFolderEdit.draft.trim();
    if (title) setBoard((current) => ({ ...current, folders: current.folders.map((folder) => folder.id === inlineFolderEdit.folderId ? { ...folder, title } : folder) }));
    setInlineFolderEdit(null);
  };

  const saveInlineSpaceEdit = () => {
    if (!inlineSpaceEdit) return;
    const title = inlineSpaceEdit.draft.trim();
    if (title) setBoard((current) => ({ ...current, spaces: current.spaces.map((space) => space.id === inlineSpaceEdit.spaceId ? { ...space, title } : space) }));
    setInlineSpaceEdit(null);
  };

  const startInlineSpaceEdit = (space: Space) => {
    setSpaceMenu(null);
    setInlineSpaceEdit({ spaceId: space.id, draft: space.title });
  };

  const deleteSpace = (space: Space) => {
    if (board.spaces.length === 1) { notify('Keep at least one space'); return; }
    const spaceIndex = board.spaces.findIndex((candidate) => candidate.id === space.id);
    const deletedFolders = board.folders.filter((folder) => folder.spaceId === space.id);
    const previousActiveSpace = board.activeSpace;
    const nextSpace = board.spaces.find((candidate) => candidate.id !== space.id)!;
    setBoard((current) => ({
      ...current,
      spaces: current.spaces.filter((candidate) => candidate.id !== space.id),
      folders: current.folders.filter((folder) => folder.spaceId !== space.id),
      activeSpace: current.activeSpace === space.id ? nextSpace.id : current.activeSpace,
    }));
    setSpaceMenu(null);
    notify(`Deleted “${space.title}”`, () => setBoard((current) => {
      if (current.spaces.some((candidate) => candidate.id === space.id)) return current;
      const spaces = [...current.spaces];
      spaces.splice(Math.min(spaceIndex, spaces.length), 0, space);
      return { ...current, spaces, folders: [...current.folders, ...deletedFolders], activeSpace: previousActiveSpace };
    }));
  };

  const deleteBookmark = (folderId: string, itemId: string) => {
    const folder = board.folders.find((candidate) => candidate.id === folderId);
    const index = folder?.items.findIndex((item) => item.id === itemId) ?? -1;
    const deleted = index >= 0 ? folder?.items[index] : undefined;
    setBoard((current) => ({ ...current, folders: current.folders.map((folder) => folder.id === folderId ? { ...folder, items: folder.items.filter((item) => item.id !== itemId) } : folder) }));
    setEditingItem(null);
    notify('Bookmark deleted', deleted ? () => setBoard((current) => ({
      ...current,
      folders: current.folders.map((candidate) => {
        if (candidate.id !== folderId || candidate.items.some((item) => item.id === itemId)) return candidate;
        const items = [...candidate.items];
        items.splice(Math.min(index, items.length), 0, deleted);
        return { ...candidate, items };
      }),
    })) : undefined);
  };

  const copyUrl = async (url: string) => {
    try { await navigator.clipboard.writeText(url); notify('URL copied'); }
    catch { notify('Could not copy the URL'); }
  };

  const openSavedBookmark = (folderId: string, item: SavedItem, newTab = false) => {
    setBoard((current) => ({
      ...current,
      folders: current.folders.map((folder) => folder.id === folderId
        ? { ...folder, items: folder.items.map((candidate) => candidate.id === item.id ? { ...candidate, lastAccessedAt: now() } : candidate) }
        : folder),
    }));
    queueOpenBookmark(item.url, newTab);
  };

  const queueFolderToggle = (folder: Folder) => {
    if (didDragFolderRef.current) return;
    if (folderClickTimerRef.current) window.clearTimeout(folderClickTimerRef.current);
    folderClickTimerRef.current = window.setTimeout(() => folderAction(folder, 'collapse'), 210);
  };

  const startInlineFolderEdit = (folder: Folder) => {
    if (folderClickTimerRef.current) window.clearTimeout(folderClickTimerRef.current);
    setFolderMenu(null);
    setInlineFolderEdit({ folderId: folder.id, draft: folder.title });
  };

  const dropIntoFolder = (folderId: string, event: React.DragEvent, targetItemId?: string, position: DropTarget['position'] = 'end') => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    const rawTabIndex = event.dataTransfer.getData('application/x-tabyou-tab');
    const tabIndex = rawTabIndex === '' ? -1 : Number(rawTabIndex);
    const savedId = event.dataTransfer.getData('application/x-tabyou-bookmark');
    if (Number.isInteger(tabIndex) && tabIndex >= 0 && openTabs[tabIndex]) {
      const tab = openTabs[tabIndex];
      const existing = board.folders.find((folder) => folder.id === folderId)?.items.find((item) => item.url === tab.url);
      if (existing) { startInlineBookmarkEdit(folderId, existing); notify('That tab is already saved here'); return; }
      const itemId = makeId();
      setBoard((current) => ({ ...current, folders: current.folders.map((folder) => {
        if (folder.id !== folderId) return folder;
        const items = [...folder.items];
        const targetIndex = targetItemId ? items.findIndex((item) => item.id === targetItemId) : -1;
        const insertAt = targetIndex < 0 ? items.length : position === 'after' ? targetIndex + 1 : targetIndex;
        items.splice(insertAt, 0, { id: itemId, title: tab.title, url: tab.url, faviconUrl: tab.faviconUrl, createdAt: now() });
        return { ...folder, items };
      }) }));
      setInlineBookmarkEdit({ folderId, itemId, draft: tab.title });
      return;
    }
    if (savedId) setBoard((current) => {
      let moving: SavedItem | undefined;
      current.folders.forEach((folder) => { const found = folder.items.find((item) => item.id === savedId); if (found) moving = found; });
      if (!moving || targetItemId === savedId) return current;
      return { ...current, folders: current.folders.map((folder) => {
        const items = folder.items.filter((item) => item.id !== savedId);
        if (folder.id !== folderId) return { ...folder, items };
        const targetIndex = targetItemId ? items.findIndex((item) => item.id === targetItemId) : -1;
        const insertAt = targetIndex < 0 ? items.length : position === 'after' ? targetIndex + 1 : targetIndex;
        items.splice(insertAt, 0, moving!);
        return { ...folder, items };
      }) };
    });
  };

  const stashAll = async () => {
    const stashable = openTabs.filter((tab) => tab.url && !tab.url.startsWith('chrome-extension://')); if (!stashable.length) return notify('No tabs to stash');
    const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date());
    setBoard((current) => ({ ...current, folders: [...current.folders, { id: makeId(), title: `Session · ${date}`, color: COLORS[current.folders.length % COLORS.length]!, spaceId: current.activeSpace, items: stashable.map((tab) => ({ id: makeId(), title: tab.title, url: tab.url, faviconUrl: tab.faviconUrl, createdAt: now() })) }] }));
    const ids = stashable.flatMap((tab) => tab.id != null && !tab.active ? [tab.id] : []); if (ids.length && typeof browser !== 'undefined') await browser.tabs.remove(ids);
    notify(`Stashed ${stashable.length} tabs`); refreshTabs();
  };
  const cleanDuplicates = async () => {
    if (!duplicateIds.length) return notify('No duplicate tabs found');
    if (typeof browser !== 'undefined') await browser.tabs.remove(duplicateIds);
    notify(`Closed ${duplicateIds.length} duplicate${duplicateIds.length === 1 ? '' : 's'}`); refreshTabs();
  };

  const refreshAllFavicons = () => {
    setBoard((current) => ({
      ...current,
      faviconRefreshRevision: Date.now(),
      folders: current.folders.map((folder) => ({ ...folder, items: folder.items.map((item) => ({ ...item, faviconUrl: undefined })) })),
    }));
    notify('Refreshing all favicons');
  };

  const folderAction = (folder: Folder, action: string) => {
    setFolderMenu(null);
    if (action === 'open') { folder.items.forEach((item) => openUrl(item.url, true)); return; }
    setBoard((current) => ({ ...current, folders: current.folders.map((item) => {
      if (item.id !== folder.id) return item;
      if (action === 'collapse') return { ...item, collapsed: !item.collapsed };
      if (action === 'archive') return { ...item, archived: true };
      return item;
    }) }));
  };
  const reorderFolder = (targetId: string) => {
    if (!draggedFolder || draggedFolder === targetId) return;
    setBoard((current) => { const folders = [...current.folders]; const from = folders.findIndex((item) => item.id === draggedFolder); const to = folders.findIndex((item) => item.id === targetId); if (from < 0 || to < 0) return current; const [moving] = folders.splice(from, 1); folders.splice(to, 0, moving!); return { ...current, folders }; });
    setDraggedFolder(null);
  };

  const exportData = () => {
    const blob = new Blob([JSON.stringify(board, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `tabyou-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url); notify('Backup exported');
  };
  const importData = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    try { const parsed = normalizeBoard(JSON.parse(await file.text())); if (!parsed) throw new Error('Invalid'); setBoard(parsed); setSettingsOpen(false); notify('Backup imported'); }
    catch { notify('That file is not a valid TabYou backup'); }
    event.target.value = '';
  };

  const importFromTabme = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const result = mergeTabmeExport(board, JSON.parse(await file.text()));
      setBoard(result.board);
      setSettingsOpen(false);
      const duplicateText = result.duplicatesSkipped ? `; skipped ${result.duplicatesSkipped} duplicate${result.duplicatesSkipped === 1 ? '' : 's'}` : '';
      notify(`Imported ${result.bookmarksAdded} bookmarks from Tabme${duplicateText}`);
    } catch {
      notify('That file is not a valid Tabme export');
    }
    event.target.value = '';
  };

  const importBrowserBookmarks = async () => {
    try {
      if (typeof browser === 'undefined' || !browser.bookmarks) throw new Error('Bookmarks API unavailable');
      const tree = await browser.bookmarks.getTree() as unknown as BrowserBookmarkNode[];
      const result = mergeBrowserBookmarkTree(board, tree);
      setBoard(result.board);
      setSettingsOpen(false);
      const duplicateText = result.duplicatesSkipped ? `; skipped ${result.duplicatesSkipped} duplicate${result.duplicatesSkipped === 1 ? '' : 's'}` : '';
      notify(`Imported ${result.bookmarksAdded} browser bookmarks into ${result.foldersAdded} new folder${result.foldersAdded === 1 ? '' : 's'}${duplicateText}`);
    } catch {
      notify('Browser bookmarks could not be imported');
    }
  };

  const archivedCount = board.folders.filter((folder) => folder.archived).length;
  const closePopovers = () => {
    setFolderMenu(null);
    setSpaceMenu(null);
    setSettingsOpen(false);
    setEditingItem(null);
  };

  return (
    <main className={`app-shell ${isResizingSidebar ? 'is-resizing-sidebar' : ''}`} style={{ '--sidebar-width': `${board.sidebarWidth}px`, '--sidebar-center-offset': `${board.sidebarWidth / 2}px` } as React.CSSProperties} onClick={closePopovers}>
      <aside className="sidebar">
        <label className="search-box"><Search size={18} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tabs and bookmarks" aria-label="Search tabs and bookmarks" />{query ? <button className="clear-search" title="Clear search" onClick={() => setQuery('')} aria-label="Clear search"><X size={15} /></button> : <kbd>⌘ K</kbd>}</label>

        <div className="sidebar-heading"><div><p className="eyebrow">BROWSER</p><h1>Open tabs <span>{visibleTabs.length}</span></h1></div><button className={`icon-button cleanup-button ${duplicateIds.length ? 'has-duplicates' : ''}`} aria-label="Close duplicate tabs" title="Close duplicate tabs" onClick={cleanDuplicates}><Eraser size={19} />{duplicateIds.length > 0 && <b>{duplicateIds.length}</b>}</button></div>

        <section className="window-card">
          <div className="window-title"><div><strong>Current window</strong><small>{openTabs.length} tabs</small></div><div className="window-actions"><button title="Stash all tabs" aria-label="Stash all tabs" onClick={stashAll}><Archive size={18} /></button></div></div>
          <div className="tab-list">
            {visibleTabs.length ? visibleTabs.map((tab, index) => {
              const sourceIndex = openTabs.indexOf(tab);
              return <button className="tab-row" key={`${tab.id ?? tab.url}-${index}`} draggable onDragStart={(event) => event.dataTransfer.setData('application/x-tabyou-tab', String(sourceIndex))} onClick={() => activateTab(tab)}><Favicon tab={tab} index={index} /><span>{tab.title}</span><i title="Close tab" onClick={(event) => { event.stopPropagation(); closeTab(tab); }}><X size={15} /></i></button>;
            }) : <div className="sidebar-empty">{query ? 'No open tabs match' : 'This window is all clear'}</div>}
          </div>
        </section>

        <section className="recent-section">
          <button className={`recent-button ${recentOpen ? 'is-open' : ''}`} aria-expanded={recentOpen} onClick={() => { setRecentOpen((open) => !open); refreshRecent(); }}><History size={18} /><strong>Recently closed</strong>{recentOpen ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</button>
          {recentOpen && <div className="recent-list">{recentTabs.length ? recentTabs.slice(0, 6).map((tab, index) => <button key={`${tab.id}-${index}`} onClick={() => tab.id && typeof browser !== 'undefined' ? browser.sessions.restore(tab.id) : openUrl(tab.url)}><Favicon tab={tab} index={index + 2} /><span>{tab.title}</span></button>) : <p>Closed tabs will appear here.</p>}</div>}
        </section>
        <div className="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" title="Drag to resize sidebar" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); setIsResizingSidebar(true); }} />
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="brand"><span className="brand-mark"><PanelsTopLeft size={18} strokeWidth={2.2} /></span><strong>TabYou</strong></div>
          <nav aria-label="Spaces">
            {board.spaces.map((space) => <div key={space.id} className={`space-tab ${space.id === board.activeSpace ? 'active-space' : ''}`}>
              {inlineSpaceEdit?.spaceId === space.id
                ? <input
                    className="space-title-input"
                    autoFocus
                    value={inlineSpaceEdit.draft}
                    onFocus={(event) => event.currentTarget.select()}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setInlineSpaceEdit({ ...inlineSpaceEdit, draft: event.target.value })}
                    onBlur={saveInlineSpaceEdit}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') { event.preventDefault(); saveInlineSpaceEdit(); }
                      if (event.key === 'Escape') setInlineSpaceEdit(null);
                    }}
                  />
                : <button className="space-name" title="Double-click to rename" onClick={() => { setSpaceMenu(null); setBoard((current) => ({ ...current, activeSpace: space.id })); }} onDoubleClick={(event) => { event.stopPropagation(); startInlineSpaceEdit(space); }}>{space.title}</button>}
              <button className="space-menu-trigger" title={`Actions for ${space.title}`} aria-label={`Actions for ${space.title}`} onClick={(event) => { event.stopPropagation(); setSettingsOpen(false); setFolderMenu(null); setSpaceMenu((id) => id === space.id ? null : space.id); }}><MoreHorizontal size={16} /></button>
              {spaceMenu === space.id && <div className="space-menu" onClick={(event) => event.stopPropagation()}>
                <button onClick={() => startInlineSpaceEdit(space)}><Pencil size={16} />Rename</button>
                <button className="danger-action" disabled={board.spaces.length === 1} title={board.spaces.length === 1 ? 'Keep at least one space' : 'Delete space and its folders'} onClick={() => deleteSpace(space)}><Trash2 size={16} />Delete</button>
              </div>}
            </div>)}
            <button className="add-space" aria-label="Add space" title="Add space" onClick={(event) => { event.stopPropagation(); addSpace(); }}><Plus size={18} /></button>
          </nav>
          <div className="top-actions">
            <button title="Settings" aria-label="Settings" className={settingsOpen ? 'is-active' : ''} onClick={(event) => { event.stopPropagation(); setFolderMenu(null); setSpaceMenu(null); setEditingItem(null); setSettingsOpen((open) => !open); }}><SettingsIcon size={19} /></button>
            {settingsOpen && (
              <section className="settings-popover" onClick={(event) => event.stopPropagation()}>
                <div className="popover-heading"><strong>Settings</strong><button title="Close settings" aria-label="Close settings" onClick={() => setSettingsOpen(false)}><X size={16} /></button></div>
                <div className="compact-setting-row">
                  <div><strong>Theme</strong><small>Light, dark, or follow your system.</small></div>
                  <select value={board.theme} onChange={(event) => setBoard((current) => ({ ...current, theme: event.target.value as Theme }))}><option value="light">Light</option><option value="dark">Dark</option><option value="auto">System</option></select>
                </div>
                <div className="compact-setting-row">
                  <div><strong>Show unused bookmarks</strong><small>Titles turn red after one month without a visit.</small></div>
                  <label className="toggle" title="Show unused bookmarks"><input type="checkbox" checked={board.showUnusedBookmarks} onChange={(event) => setBoard((current) => ({ ...current, showUnusedBookmarks: event.target.checked }))} /><span /></label>
                </div>
                <div className="popover-separator" />
                <button className="settings-action" onClick={refreshAllFavicons}><RefreshCw size={17} /><span><strong>Refresh all favicons</strong><small>Replace imported icons with fresh browser icons</small></span></button>
                <button className="settings-action" onClick={importBrowserBookmarks}><Download size={17} /><span><strong>Import browser bookmarks</strong><small>Bookmark folders become board folders</small></span></button>
                <button className="settings-action" onClick={() => tabmeImportRef.current?.click()}><Download size={17} /><span><strong>Import from Tabme</strong><small>Choose an official Tabme JSON export</small></span></button>
                <input ref={tabmeImportRef} type="file" accept="application/json,.json" onChange={importFromTabme} hidden />
                <button className="settings-action" onClick={exportData}><Download size={17} /><span><strong>Export backup</strong><small>Download all spaces and bookmarks</small></span></button>
                <button className="settings-action" onClick={() => importRef.current?.click()}><Archive size={17} /><span><strong>Import backup</strong><small>Restore a TabYou JSON backup</small></span></button>
                <input ref={importRef} type="file" accept="application/json,.json" onChange={importData} hidden />
                {archivedCount > 0 && <><div className="popover-separator" /><button className="settings-action" onClick={() => setBoard((current) => ({ ...current, folders: current.folders.map((folder) => ({ ...folder, archived: false })) }))}><FolderIcon size={17} /><span><strong>Restore archived folders</strong><small>{archivedCount} archived folder{archivedCount === 1 ? '' : 's'}</small></span></button></>}
              </section>
            )}
          </div>
        </header>

        <div className="board">
          {visibleFolders.map((folder, index) => (
            <article
              className={`folder-card ${draggedFolder === folder.id ? 'dragging-folder' : ''} ${dropTarget?.folderId === folder.id && dropTarget.position === 'end' ? 'drop-at-end' : ''}`}
              style={{ '--folder-color': folder.color } as React.CSSProperties}
              key={folder.id}
              onDragOver={(event) => {
                if (event.target === event.currentTarget) {
                  event.preventDefault();
                  setDropTarget({ folderId: folder.id, position: 'end' });
                }
              }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(null); }}
              onDrop={(event) => { reorderFolder(folder.id); dropIntoFolder(folder.id, event); }}
            >
              <header
                draggable={!inlineFolderEdit || inlineFolderEdit.folderId !== folder.id}
                onClick={() => queueFolderToggle(folder)}
                onDoubleClick={(event) => { event.stopPropagation(); startInlineFolderEdit(folder); }}
                onDragStart={() => { didDragFolderRef.current = true; setDraggedFolder(folder.id); }}
                onDragEnd={() => { setDraggedFolder(null); window.setTimeout(() => { didDragFolderRef.current = false; }, 80); }}
                title="Click to collapse or expand. Double-click the name to rename."
              >
                <div>
                  {inlineFolderEdit?.folderId === folder.id
                    ? <input
                        className="folder-title-input"
                        autoFocus
                        value={inlineFolderEdit.draft}
                        onFocus={(event) => event.currentTarget.select()}
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onChange={(event) => setInlineFolderEdit({ ...inlineFolderEdit, draft: event.target.value })}
                        onBlur={saveInlineFolderEdit}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') { event.preventDefault(); saveInlineFolderEdit(); }
                          if (event.key === 'Escape') setInlineFolderEdit(null);
                        }}
                      />
                    : <h3>{folder.title}</h3>}
                </div>
                <button className="folder-menu-trigger" title="Folder actions" aria-label={`Menu for ${folder.title}`} onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setSpaceMenu(null); setFolderMenu((id) => id === folder.id ? null : folder.id); }}><MoreHorizontal size={19} /></button>
                {folderMenu === folder.id && <div className="folder-menu" onClick={(event) => event.stopPropagation()}>
                  <div className="folder-color-grid" aria-label="Folder color">
                    {COLORS.map((color) => <button key={color} className={`color-swatch ${folder.color.toLowerCase() === color.toLowerCase() ? 'is-selected' : ''}`} style={{ background: color }} title={`Use ${color}`} aria-label={`Use color ${color}`} onClick={() => { setBoard((current) => ({ ...current, folders: current.folders.map((candidate) => candidate.id === folder.id ? { ...candidate, color } : candidate) })); setFolderMenu(null); }} />)}
                  </div>
                  <div className="folder-menu-separator" />
                  <button onClick={() => folderAction(folder, 'open')}><ExternalLink size={16} />Open all</button>
                  <button onClick={() => folderAction(folder, 'collapse')}>{folder.collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}{folder.collapsed ? 'Expand' : 'Collapse'}</button>
                  <button onClick={() => startInlineFolderEdit(folder)}><Pencil size={16} />Rename</button>
                  <button onClick={() => folderAction(folder, 'archive')}><Archive size={16} />Archive</button>
                </div>}
              </header>

              {!folder.collapsed && <div className="bookmark-list">
                {folder.items.filter((item) => !normalizedQuery || `${item.title} ${item.url}`.toLowerCase().includes(normalizedQuery)).map((item, itemIndex) => {
                  const isInlineEditing = inlineBookmarkEdit?.itemId === item.id;
                  const dropClass = dropTarget?.itemId === item.id ? `drop-${dropTarget.position}` : '';
                  const lastUsed = new Date(item.lastAccessedAt ?? item.createdAt).getTime();
                  const isUnused = board.showUnusedBookmarks && Number.isFinite(lastUsed) && Date.now() - lastUsed >= UNUSED_AFTER_MS;
                  return <div
                    className={`bookmark-row ${dropClass} ${isUnused ? 'is-unused' : ''}`}
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    draggable={!isInlineEditing}
                    onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-tabyou-bookmark', item.id); }}
                    onDragEnd={() => setDropTarget(null)}
                    onDragOver={(event) => {
                      event.preventDefault(); event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                      setDropTarget({ folderId: folder.id, itemId: item.id, position });
                    }}
                    onDrop={(event) => dropIntoFolder(folder.id, event, item.id, dropTarget?.position === 'after' ? 'after' : 'before')}
                    onClick={(event) => !isInlineEditing && openSavedBookmark(folder.id, item, event.metaKey || event.ctrlKey)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (!isInlineEditing) editBookmark(folder.id, item, event.currentTarget);
                    }}
                    onDoubleClick={(event) => { event.preventDefault(); startInlineBookmarkEdit(folder.id, item); }}
                    onKeyDown={(event) => { if (event.key === 'Enter' && !isInlineEditing) openSavedBookmark(folder.id, item, event.metaKey || event.ctrlKey); }}
                    title="Double-click the name to rename"
                  >
                    <Favicon tab={item} index={itemIndex + index} refreshKey={board.faviconRefreshRevision} />
                    <span>
                      {isInlineEditing
                        ? <input
                            className="bookmark-title-input"
                            autoFocus
                            value={inlineBookmarkEdit.draft}
                            onFocus={(event) => event.currentTarget.select()}
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onChange={(event) => setInlineBookmarkEdit({ ...inlineBookmarkEdit, draft: event.target.value })}
                            onBlur={saveInlineBookmarkEdit}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === 'Enter') { event.preventDefault(); saveInlineBookmarkEdit(); }
                              if (event.key === 'Escape') setInlineBookmarkEdit(null);
                            }}
                          />
                        : <strong>{item.title}</strong>}
                      <small>{domainFromUrl(item.url)}</small>
                    </span>
                    <button className="bookmark-menu-trigger" title="Bookmark actions" aria-label={`Actions for ${item.title}`} onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); editBookmark(folder.id, item, event.currentTarget); }}><MoreHorizontal size={18} /></button>
                  </div>;
                })}
              </div>}
              {!folder.collapsed && <div className={`folder-drop-end ${dropTarget?.folderId === folder.id && dropTarget.position === 'end' ? 'is-target' : ''}`} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); setDropTarget({ folderId: folder.id, position: 'end' }); }} onDrop={(event) => dropIntoFolder(folder.id, event)} />}
            </article>
          ))}

          {!normalizedQuery && <button className="new-folder-tile" onClick={addFolder}><strong>New folder</strong><span><Plus size={17} />Click to add</span></button>}
          {!visibleFolders.length && normalizedQuery && <div className="empty-board"><Sparkles size={28} /><h3>Nothing found here</h3><p>Try a different search, or switch spaces.</p></div>}
        </div>
      </section>

      {editingItem && <section className="bookmark-popover" style={{ left: editingItem.x, top: editingItem.y }} onClick={(event) => event.stopPropagation()}>
        <label><span>Title</span><input autoFocus value={editingItem.title} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setEditingItem((item) => item ? { ...item, title: event.target.value } : null)} onBlur={() => saveEditedBookmark(false)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); saveEditedBookmark(false); } }} /></label>
        <label><span>URL</span><input value={editingItem.url} onChange={(event) => setEditingItem((item) => item ? { ...item, url: event.target.value } : null)} onBlur={() => saveEditedBookmark(false)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); saveEditedBookmark(false); } }} /></label>
        <div className="bookmark-popover-actions">
          <button onMouseDown={(event) => event.preventDefault()} onClick={copyEditedUrl}><Copy size={17} />Copy URL</button>
          <button className="danger-action" onMouseDown={(event) => event.preventDefault()} onClick={() => deleteBookmark(editingItem.folderId, editingItem.itemId)}><Trash2 size={17} />Delete</button>
        </div>
      </section>}
      {toast && <div className="toast"><span><Check size={13} /></span><strong>{toast.message}</strong>{toast.undo && <button onClick={() => { toast.undo?.(); setToast(null); }}>Undo</button>}</div>}
    </main>
  );
}
