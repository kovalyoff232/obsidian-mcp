#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "url";
import path from "path";
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, statSync, rmSync } from "fs";
import YAML from 'yaml';
import Fuse from "fuse.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
interface ObsidianNote {
    path: string;
    content_preview: string;
    vector?: number[];
    id?: string;
    title?: string;
    description?: string;
    content?: string;
    lastModified?: string;
    tags?: string[];
    links?: string[];
    size?: number;
    fullPath?: string;
    aliases?: string[];
    type?: string;
}
interface ParsedQuery {
    terms: string[];
    exactPhrases: string[];
    requiredTerms: string[];
    excludedTerms: string[];
    fieldQueries: {
        field: string;
        value: string;
    }[];
    operators: {
        type: 'AND' | 'OR';
        terms: string[];
    }[];
}
enum NoteCategory {
    DOCUMENTATION = '📚 Documentation',
    PROJECT_SPEC = '📋 Specifications',
    TUTORIAL = '🎓 Tutorials',
    CODE_SAMPLES = '💻 Code samples',
    TODO_TASKS = '✅ Tasks and TODO',
    PERSONAL_NOTES = '📝 Personal notes',
    REFERENCE = '🔖 Reference',
    OTHER = '📄 Other'
}
class QueryParser {
    static parse(query: string): ParsedQuery {
        const result: ParsedQuery = {
            terms: [],
            exactPhrases: [],
            requiredTerms: [],
            excludedTerms: [],
            fieldQueries: [],
            operators: []
        };
        const fieldRegex = /([\w\.]+):(?:"([^"]+)"|([^\s]+))/g;
        let match;
        while ((match = fieldRegex.exec(query)) !== null) {
            const field = (match[1] || '').toLowerCase();
            const value = (match[2] || match[3] || '').toLowerCase();
            if (field && value) {
                result.fieldQueries.push({ field, value });
            }
            query = query.replace(match[0], '');
        }
        const phraseRegex = /"([^"]+)"/g;
        while ((match = phraseRegex.exec(query)) !== null) {
            result.exactPhrases.push((match[1] || '').toLowerCase());
            query = query.replace(match[0], '');
        }
        const words = query.split(/\s+/).filter(word => word.trim().length > 0);
        for (const word of words) {
            const trimmed = word.trim().toLowerCase();
            if (!trimmed)
                continue;
            if (trimmed.startsWith('+')) {
                const term = trimmed.substring(1);
                if (term.length > 0)
                    result.requiredTerms.push(term);
            }
            else if (trimmed.startsWith('-')) {
                const term = trimmed.substring(1);
                if (term.length > 0)
                    result.excludedTerms.push(term);
            }
            else if (trimmed === 'and' || trimmed === 'or') {
                continue;
            }
            else {
                result.terms.push(trimmed);
            }
        }
        return result;
    }
}
class NoteCategorizer {
    static categorize(note: ObsidianNote): NoteCategory {
        const path = note.path.toLowerCase();
        const title = (note.title || '').toLowerCase();
        const content = (note.content || note.content_preview || '').toLowerCase();
        if (path.includes('документация') || path.includes('docs/')) {
            return NoteCategory.DOCUMENTATION;
        }
        if (path.includes('тз ') || path.includes('spec') || path.includes('requirements')) {
            return NoteCategory.PROJECT_SPEC;
        }
        if (path.includes('tutorial') || path.includes('обучение') || path.includes('guide')) {
            return NoteCategory.TUTORIAL;
        }
        if (path.includes('examples') || path.includes('samples') || path.includes('примеры')) {
            return NoteCategory.CODE_SAMPLES;
        }
        if (title.includes('todo') || title.includes('задач') || content.includes('- [ ]') || content.includes('☐')) {
            return NoteCategory.TODO_TASKS;
        }
        if (title.includes('readme') || title.includes('документация') || content.includes('# документация')) {
            return NoteCategory.DOCUMENTATION;
        }
        if (title.includes('тз') || title.includes('техническое задание') || content.includes('## тз')) {
            return NoteCategory.PROJECT_SPEC;
        }
        if (content.includes('```') && (content.includes('function') || content.includes('class') || content.includes('const'))) {
            return NoteCategory.CODE_SAMPLES;
        }
        if (title.includes('справочник') || content.includes('api reference') || content.includes('документация api')) {
            return NoteCategory.REFERENCE;
        }
        return NoteCategory.OTHER;
    }
}
interface SearchResult {
    id: string;
    title: string;
    description: string;
    path: string;
    lastModified: string;
    score: number;
    type: string;
    content_preview: string;
    tags?: string[];
    links?: string[];
    confidence: string;
}
interface GraphPolicy {
    mode?: 'warn' | 'block';
    roots?: string[];
    global?: {
        frontmatter?: {
            disallow_keys?: string[];
        };
        body?: {
            wikilinks?: {
                max_total?: number;
                only_to_parent?: boolean;
            };
            banned_headings?: string[];
        };
    };
    links?: {
        parentKey?: string;
        otherKeys?: string[];
        relationsHeading?: string;
        defaultRelation?: string;
    };
    folders?: {
        canonicalPrefix?: string;
        hubs?: {
            defaultPath?: string;
        };
        index?: {
            autoCreate?: boolean;
            noteType?: string;
            summaryHeading?: string;
            relationsHeading?: string;
        };
    };
    types?: Record<string, {
        required?: string[];
        mustHaveParent?: boolean;
        allowMultipleParents?: boolean;
        allowedParentTypes?: string[];
        allowedParentTitles?: string[];
        allowedParentPathIncludes?: string[];
    }>;
}
const DEFAULT_LIMIT = 20;
const SCRIPT_DIR = path.dirname(__filename);
const PLUGIN_ROOT = path.join(SCRIPT_DIR, '..');
function findIndexPath(): string {
    const indexPath = path.join(PLUGIN_ROOT, 'index.json');
    console.error(`🔍 Looking for index.json at: ${indexPath}\n`);
    console.error(`🔍 Script dir: ${SCRIPT_DIR}`);
    console.error(`🔍 Plugin root: ${PLUGIN_ROOT}`);
    return indexPath;
}
let serverInstance: ObsidianMCPServer | null = null;
class ObsidianMCPServer {
    private indexData: ObsidianNote[] = [];
    private synonyms: Record<string, string[]> = {};
    private categories: Record<string, string[]> = {};
    private isLoaded: boolean = false;
    private vaultPath: string = '';
    private fuse: Fuse<ObsidianNote> | null = null;
    private indexRevision: number = 0;
    private backlinkIndex: Map<string, Set<string>> = new Map();
    private searchCache = new Map<string, {
        results: SearchResult[];
        timestamp: number;
        hitCount: number;
    }>();
    private readonly CACHE_TTL = 5 * 60 * 1000;
    private readonly MAX_CACHE_SIZE = 100;
    private heavyCache = new Map<string, {
        value: any;
        ts: number;
    }>();
    private readonly HEAVY_TTL = 3 * 60 * 1000;
    private readonly HEAVY_MAX = 50;
    private readonly INDEX_DEBOUNCE_MS: number = (() => {
        const v = parseInt(process.env.MCP_INDEX_DEBOUNCE_MS || '500', 10);
        return Number.isFinite(v) && v >= 0 ? v : 500;
    })();
    private readonly SEM_ALPHA: number = (() => {
        const v = parseFloat(process.env.MCP_SEMANTIC_ALPHA || '0.7');
        return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.7;
    })();
    private readonly SEM_MINLEN_QUERY: number = (() => {
        const v = parseInt(process.env.MCP_SEMANTIC_MINLEN_QUERY || '40', 10);
        return Number.isFinite(v) && v >= 0 ? v : 40;
    })();
    private readonly SEM_MAX_SCAN: number = (() => {
        const v = parseInt(process.env.MCP_SEMANTIC_MAX_SCAN || '2000', 10);
        return Number.isFinite(v) && v > 0 ? v : 2000;
    })();
    private readonly SNIPPET_LEN: number = (() => {
        const v = parseInt(process.env.MCP_SNIPPET_LEN || '200', 10);
        return Number.isFinite(v) && v > 50 ? v : 200;
    })();
    private indexDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
    private semanticEnabled: boolean = false;
    private embedStore: Map<string, number[]> = new Map();
    private embedStorePath: string = '';
    private embedPersist: boolean = true;
    private embedSaveTimer: NodeJS.Timeout | null = null;
    private embedPending: Set<string> = new Set();
    private embedUpdateTimer: NodeJS.Timeout | null = null;
    private embedDirty: boolean = false;
    private embedBackup: boolean = true;
    private embedProvider: 'hash' | 'xenova' = 'hash';
    private embedModel: string = 'Xenova/all-MiniLM-L6-v2';
    private embedXenovaPipeline: any = null;
    private graphPolicy: GraphPolicy = {};
    private graphPolicyPath: string = '';
    private graphPolicyMtime: number = 0;
    private policyMode: 'warn' | 'block' = 'warn';
    private parentKey: string = 'part_of';
    private relationsHeading: string = 'Relations';
    private searchStats = {
        totalSearches: 0,
        cacheHits: 0,
        avgSearchTime: 0,
        popularQueries: new Map<string, number>(),
        popularWords: new Map<string, number>(),
        searchesByHour: new Array(24).fill(0),
        categoriesFound: new Map<string, number>(),
        advancedOperatorsUsed: 0,
        linkedNotesFound: 0
    };
    private stemLibsInitialized: boolean = false;
    private ruStemFn?: (word: string) => string;
    private enStemFn?: (word: string) => string;
    constructor() {
        this.synonyms = this._loadSynonyms();
        try {
            const userSyn = this._loadUserSynonymsFromVault();
            if (userSyn && Object.keys(userSyn).length > 0) {
                for (const [k, arr] of Object.entries(userSyn)) {
                    const base = this.synonyms[k] || [];
                    this.synonyms[k] = [...new Set([...base, ...arr])];
                }
                console.error(`🧩 User synonyms merged: +${Object.keys(userSyn).length} entries`);
            }
        }
        catch { }
        this.categories = this._initCategories();
        this.vaultPath = this.findVaultPath();
        try {
            this.loadGraphPolicy();
        }
        catch (e) {
            console.error('⚠️ graph policy load failed:', e);
        }
        this.initStemLibsAsync();
        this.semanticEnabled = (process.env.MCP_SEMANTIC_ENABLED === 'true');
        this.embedPersist = (process.env.MCP_SEMANTIC_PERSIST !== 'false');
        this.embedStorePath = process.env.MCP_SEMANTIC_STORE || path.join(PLUGIN_ROOT, 'semantic_index.json');
        this.embedBackup = (process.env.MCP_SEMANTIC_BACKUP !== 'false');
        console.error(`🧠 Semantic layer ${this.semanticEnabled ? 'ENABLED' : 'disabled'} (env MCP_SEMANTIC_ENABLED)`);
        console.error(`💾 Semantic persist ${this.embedPersist ? 'ON' : 'off'} → ${this.embedStorePath} (backup ${this.embedBackup ? 'ON' : 'off'})`);
        try {
            this.loadEmbedStoreFromDisk();
        }
        catch (e) {
            console.error('⚠️ semantic store load failed:', e);
        }
        try {
            this.initEmbedProviderAsync();
        }
        catch { }
    }
    public getQueryPresets(): Record<string, string> {
        return {
            'classes:all': 'type:class',
            'taxonomy:all': 'tags:taxonomy',
            'taxonomy:drugs': 'tags:"drug-class"',
            'pharma:antidepressants': 'path:Антидепрессанты',
            'pharma:ssri': '+SSRI fm.taxonomy:"Антидепрессанты"',
            'pharma:ai-drafts': 'fm.source:ai fm.type:class path:Фармакология',
            'obsidian:plugins': 'path:graph/ Knowledge Hub/ Инструменты/ Шаблонизация/ Плагины',
            'obsidian:templating': 'path:Шаблонизация related:Templater',
            'drafts:ai': 'fm.source:ai status:draft',
            'drafts:non-ai': '-fm.source:ai status:draft',
            'diagnostics:has-hub-link': 'content:"[[Knowledge Hub]]" -type:class',
            'diagnostics:leaf-direct-hub': 'related:"Knowledge Hub" -type:class',
            'aliases:antidepressants': 'aliases:"Antidepressants"',
        };
    }
    loadIndexSync() {
        if (this.isLoaded)
            return;
        this.loadIndex().catch(console.error);
    }
    private bumpRevisionAndInvalidate() {
        this.indexRevision++;
        this.clearCache();
        this.heavyCache.clear();
    }
    private heavyKey(name: string, args: any): string {
        return JSON.stringify({ n: name, a: args, rev: this.indexRevision });
    }
    private heavyGet(key: string): any | null {
        const e = this.heavyCache.get(key);
        if (!e)
            return null;
        if (Date.now() - e.ts > this.HEAVY_TTL) {
            this.heavyCache.delete(key);
            return null;
        }
        return e.value;
    }
    private heavySet(key: string, value: any) {
        if (this.heavyCache.size >= this.HEAVY_MAX) {
            const firstKey = this.heavyCache.keys().next().value;
            if (firstKey)
                this.heavyCache.delete(firstKey);
        }
        this.heavyCache.set(key, { value, ts: Date.now() });
    }
    private findVaultPath(): string {
        const vaultPath = path.join(PLUGIN_ROOT, '../../../');
        const normalizedPath = path.resolve(vaultPath);
        console.error(`📂 Vault path detected: ${normalizedPath}/`);
        console.error(`📂 Plugin root dir: ${PLUGIN_ROOT}`);
        return normalizedPath;
    }
    async loadIndex(): Promise<void> {
        try {
            const INDEX_PATH = findIndexPath();
            console.error(`🔍 Attempting to load index from: ${INDEX_PATH}\n`);
            if (existsSync(INDEX_PATH)) {
                const rawData = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
                console.error(`🔍 Raw data contains ${rawData.length} items`);
                console.error(`🔍 First item keys:`, Object.keys(rawData[0] || {}));
                if (!Array.isArray(rawData)) {
                    throw new Error('Index data is not an array');
                }
                const shouldExclude = (p: string) => {
                    const lp = (p || '').toLowerCase();
                    return lp.startsWith('.obsidian/') || lp.includes('/.obsidian/') ||
                        lp.includes('/node_modules/') || lp.startsWith('node_modules/') ||
                        lp.includes('/.venv/') || lp.startsWith('.venv/') ||
                        lp.includes('/venv/') || lp.startsWith('venv/') ||
                        lp.includes('/dist/') || lp.startsWith('dist/') ||
                        lp.includes('/build/') || lp.startsWith('build/');
                };
                this.indexData = rawData
                    .filter((item: any) => !shouldExclude(item.path))
                    .map((item, index) => ({
                    ...item,
                    id: item.id || `note_${index}`,
                    title: item.title || path.basename(item.path, '.md'),
                    description: item.description || item.content_preview?.substring(0, 150) || '',
                    lastModified: item.lastModified || new Date().toISOString(),
                    tags: item.tags || [],
                    links: item.links || [],
                    fullPath: path.join(this.vaultPath, item.path)
                }));
                await this.loadFullContent();
                this.initializeFuse();
                this.isLoaded = true;
                this.rebuildBacklinkIndex();
                this.bumpRevisionAndInvalidate();
                console.error(`✅ Successfully loaded ${this.indexData.length} notes from index`);
                console.error(`🚀 Fuse.js search engine initialized with full content`);
            }
            else {
                console.error(`❌ Index file not found: ${INDEX_PATH}`);
                console.error(`💡 Make sure your Obsidian notes are properly indexed`);
            }
        }
        catch (error) {
            console.error(`❌ Error loading index:`, error);
        }
    }
    private async loadFullContent(): Promise<void> {
        console.error(`📄 Loading full content for ${this.indexData.length} notes...`);
        for (const note of this.indexData) {
            if (note.fullPath && existsSync(note.fullPath)) {
                try {
                    note.content = readFileSync(note.fullPath, 'utf-8');
                    try {
                        const { frontmatter } = this.parseFrontmatterAndBody(note.content || '');
                        const fmTags = (frontmatter && frontmatter['tags']) as any;
                        if (Array.isArray(fmTags)) {
                            note.tags = fmTags.map((t: any) => String(t));
                        }
                        else if (typeof fmTags === 'string' && fmTags.trim().length > 0) {
                            note.tags = fmTags.split(/[\s,]+/).filter(Boolean);
                        }
                        const fmAliases = (frontmatter && frontmatter['aliases']) as any;
                        if (Array.isArray(fmAliases)) {
                            note.aliases = fmAliases.map((t: any) => String(t));
                        }
                        else if (typeof fmAliases === 'string' && fmAliases.trim().length > 0) {
                            note.aliases = fmAliases.split(/[\s,]+/).filter(Boolean);
                        }
                        if (typeof frontmatter?.['type'] === 'string') {
                            note.type = frontmatter['type'];
                        }
                    }
                    catch { }
                }
                catch (error) {
                    console.error(`❌ Failed to read ${note.fullPath}:`, error);
                    note.content = note.content_preview || '';
                }
            }
            else {
                note.content = note.content_preview || '';
            }
        }
        console.error(`📚 Loaded full content for ${this.indexData.length}/${this.indexData.length} notes`);
    }
    public async reindexVault(): Promise<{
        notes: number;
    }> {
        const INDEX_PATH = findIndexPath();
        const vaultRoot = path.resolve(this.vaultPath);
        const collected: ObsidianNote[] = [];
        const shouldExclude = (relPath: string): boolean => {
            const lp = (relPath || '').toLowerCase();
            return lp.startsWith('.obsidian/') || lp.includes('/.obsidian/') ||
                lp.startsWith('node_modules/') || lp.includes('/node_modules/') ||
                lp.startsWith('.venv/') || lp.includes('/.venv/') ||
                lp.startsWith('venv/') || lp.includes('/venv/') ||
                lp.startsWith('dist/') || lp.includes('/dist/') ||
                lp.startsWith('build/') || lp.includes('/build/');
        };
        const walk = (dir: string) => {
            const entries = readdirSync(dir);
            for (const entry of entries) {
                const full = path.join(dir, entry);
                const st = statSync(full);
                if (st.isDirectory()) {
                    const relDir = path.relative(vaultRoot, full).replace(/\\/g, '/');
                    if (shouldExclude(relDir + '/'))
                        continue;
                    walk(full);
                }
                else if (st.isFile() && entry.toLowerCase().endsWith('.md')) {
                    const rel = path.relative(vaultRoot, full).replace(/\\/g, '/');
                    if (shouldExclude(rel))
                        continue;
                    const content = readFileSync(full, 'utf-8');
                    collected.push({
                        path: rel,
                        content_preview: content.slice(0, 300),
                        title: path.basename(rel, '.md'),
                        description: content.split('\n').find(l => l.trim().length > 0)?.slice(0, 150) || '',
                        lastModified: new Date(st.mtimeMs).toISOString(),
                        fullPath: full
                    } as any);
                }
            }
        };
        walk(vaultRoot);
        try {
            writeFileSync(INDEX_PATH, JSON.stringify(collected, null, 2), { encoding: 'utf-8' });
        }
        catch (e) {
            console.error('❌ Failed to write index.json:', e);
        }
        this.indexData = collected.map((item, index) => ({
            ...item,
            id: item.id || `note_${index}`,
            tags: item.tags || [],
            links: item.links || [],
            size: item.size || item.content_preview.length
        }));
        await this.loadFullContent();
        this.initializeFuse();
        this.isLoaded = true;
        this.rebuildBacklinkIndex();
        this.bumpRevisionAndInvalidate();
        return { notes: this.indexData.length };
    }
    private initializeFuse(mode: 'balanced' | 'taxonomy' | 'semantic' = 'balanced'): void {
        const isTaxonomy = mode === 'taxonomy';
        const isSemantic = mode === 'semantic';
        const fuseOptions = {
            keys: [
                { name: 'title', weight: isTaxonomy ? 0.6 : (isSemantic ? 0.3 : 0.5) },
                { name: 'content', weight: isTaxonomy ? 0.2 : (isSemantic ? 0.5 : 0.3) },
                { name: 'description', weight: 0.15 },
                { name: 'path', weight: 0.05 },
                { name: 'tags', weight: isTaxonomy ? 0.1 : 0.05 },
                { name: 'aliases', weight: 0.2 },
                { name: 'type', weight: isTaxonomy ? 0.09 : 0.05 }
            ],
            threshold: isTaxonomy ? 0.28 : (isSemantic ? 0.35 : 0.25),
            distance: isSemantic ? 50 : 30,
            minMatchCharLength: 3,
            useExtendedSearch: true,
            ignoreLocation: true,
            getFn: (obj: any, pathKey: string) => {
                const val: any = (Fuse as any).config.getFn(obj, pathKey);
                if (typeof val === 'string')
                    return this.normalizeQuery(val);
                if (Array.isArray(val))
                    return val.map(v => typeof v === 'string' ? this.normalizeQuery(v) : v);
                return val;
            }
        };
        this.fuse = new Fuse(this.indexData, fuseOptions as any);
        console.error(`🔧 Fuse.js initialized [mode=${mode}] with ${this.indexData.length} searchable notes`);
    }
    private indexSingleFile(relativePathInput: string): void {
        try {
            const INDEX_PATH = findIndexPath();
            const rel = relativePathInput.replace(/^\/+/, '');
            const relWithExt = rel.toLowerCase().endsWith('.md') ? rel : `${rel}.md`;
            const full = path.resolve(this.vaultPath, relWithExt);
            if (!existsSync(full))
                return;
            const st = statSync(full);
            const content = readFileSync(full, 'utf-8');
            const title = path.basename(relWithExt, '.md');
            const description = content.split('\n').find(l => l.trim().length > 0)?.slice(0, 150) || '';
            const updated: ObsidianNote = {
                path: relWithExt,
                content_preview: content.slice(0, 300),
                title,
                description,
                lastModified: new Date(st.mtimeMs).toISOString(),
                fullPath: full
            } as any;
            const idx = this.indexData.findIndex(n => n.path === relWithExt);
            if (idx >= 0) {
                this.indexData[idx] = { ...this.indexData[idx], ...updated };
            }
            else {
                this.indexData.push({ ...updated, id: `note_${this.indexData.length}` });
            }
            const noteRef = this.indexData.find(n => n.path === relWithExt)!;
            noteRef.content = content;
            this.initializeFuse();
            this.rebuildBacklinkIndex();
            this.bumpRevisionAndInvalidate();
            try {
                writeFileSync(INDEX_PATH, JSON.stringify(this.indexData.map(n => ({
                    path: n.path,
                    content_preview: n.content_preview,
                    title: n.title,
                    description: n.description,
                    lastModified: n.lastModified,
                    fullPath: n.fullPath
                })), null, 2), { encoding: 'utf-8' });
            }
            catch (e) {
                console.error('❌ Failed to persist incremental index:', e);
            }
        }
        catch (e) {
            console.error('❌ indexSingleFile error:', e);
        }
    }
    private scheduleIndexSingleFile(relativePathInput: string, delayMs?: number): void {
        try {
            const rel = relativePathInput.replace(/^\/+/, '');
            const relWithExt = rel.toLowerCase().endsWith('.md') ? rel : `${rel}.md`;
            const t = this.indexDebounceTimers.get(relWithExt);
            if (t) {
                clearTimeout(t);
                this.indexDebounceTimers.delete(relWithExt);
            }
            const delay = Math.max(50, typeof delayMs === 'number' ? delayMs : this.INDEX_DEBOUNCE_MS);
            const timer = setTimeout(() => {
                try {
                    this.indexSingleFile(relWithExt);
                }
                catch { }
                try {
                    this.scheduleEmbedUpdate(relWithExt);
                }
                catch { }
                this.indexDebounceTimers.delete(relWithExt);
            }, delay);
            this.indexDebounceTimers.set(relWithExt, timer);
        }
        catch { }
    }
    private expandQueryWithSynonyms(query: string): string[] {
        const expandedQueries: string[] = [];
        const queryLower = (query || '').toLowerCase();
        expandedQueries.push(queryLower);
        const normalized = this.normalizeQuery(queryLower);
        if (normalized && normalized !== queryLower)
            expandedQueries.push(normalized);
        for (const [key, synonyms] of Object.entries(this.synonyms)) {
            if (key === queryLower || synonyms.some(syn => queryLower.includes(syn))) {
                expandedQueries.push(key);
                expandedQueries.push(...synonyms);
            }
        }
        return [...new Set(expandedQueries.filter(Boolean))];
    }
    private highlightMatches(text: string, query: string): string {
        if (!text || !query)
            return text;
        const queryWords = this.extractQueryWords(query);
        let highlightedText = text;
        for (const word of queryWords) {
            if (word.length < 2)
                continue;
            const regex = new RegExp(`(${this.escapeRegex(word)})`, 'gi');
            highlightedText = highlightedText.replace(regex, '**$1**');
        }
        return highlightedText;
    }
    private extractQueryWords(query: string): string[] {
        const words = (query || '').toLowerCase()
            .split(/[\s\-_.,;:!?()[\]{}"']+/)
            .filter(word => word.length >= 2)
            .filter(word => !/^\d+$/.test(word))
            .map(w => this.normalizeWord(w));
        const expandedWords = [...words];
        for (const word of words) {
            for (const [key, synonyms] of Object.entries(this.synonyms)) {
                if (key === word || synonyms.includes(word)) {
                    expandedWords.push(key, ...synonyms);
                }
            }
        }
        return [...new Set(expandedWords.filter(Boolean))];
    }
    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    private normalizeWord(word: string): string {
        if (!word)
            return word;
        let w = word.toLowerCase();
        if (/^\d+$/.test(w))
            return w;
        const hasCyrillic = /[\u0400-\u04FF]/.test(w);
        try {
            if (hasCyrillic && this.ruStemFn) {
                const stemmed = this.ruStemFn(w);
                if (typeof stemmed === 'string' && stemmed.length >= 2)
                    return stemmed;
            }
            if (!hasCyrillic && this.enStemFn) {
                const stemmed = this.enStemFn(w);
                if (typeof stemmed === 'string' && stemmed.length >= 2)
                    return stemmed;
            }
        }
        catch { }
        const enSuffixes = ['ingly', 'edly', 'ments', 'ations', 'ation', 'ingly', 'edly', 'ment', 'ness', 'ingly', 'ing', 'edly', 'ed', 'ions', 'ion', 'ers', 'er', 'es', 'ly', 's'];
        for (const suf of enSuffixes) {
            if (w.endsWith(suf) && w.length - suf.length >= 3) {
                w = w.slice(0, -suf.length);
                break;
            }
        }
        const ruSuffixes = ['иями', 'ями', 'ами', 'ыми', 'ими', 'кого', 'кому', 'ому', 'его', 'ему', 'ого', 'ее', 'ие', 'ые', 'ая', 'яя', 'ою', 'ею', 'ую', 'ью', 'ой', 'ый', 'ий', 'ых', 'ов', 'ев', 'ам', 'ям', 'ах', 'ях', 'ом', 'ем', 'ую', 'ию', 'ешь', 'ишь', 'ать', 'ять', 'ить', 'ешься', 'ишься', 'аться', 'яться', 'итьcя', 'иваться', 'ываться', 'овать', 'ирование', 'ированн', 'ирование', 'ение', 'ений', 'ениям', 'ениями', 'енией'];
        for (const suf of ruSuffixes) {
            if (w.endsWith(suf) && w.length - suf.length >= 3) {
                w = w.slice(0, -suf.length);
                break;
            }
        }
        return w;
    }
    private normalizeQuery(query: string): string {
        const parts = (query || '').toLowerCase().split(/[\s\-_.,;:!?()[\]{}"']+/).filter(Boolean);
        const normalized = parts.map(p => this.normalizeWord(p));
        return Array.from(new Set(normalized)).join(' ');
    }
    private initStemLibsAsync(): void {
        if (this.stemLibsInitialized)
            return;
        this.stemLibsInitialized = true;
        const natPkg = 'natural';
        (import(natPkg as any) as any).then((mod: any) => {
            try {
                const ps = mod?.PorterStemmer;
                if (ps && typeof ps.stem === 'function') {
                    this.enStemFn = (w: string) => {
                        try {
                            return ps.stem(w);
                        }
                        catch {
                            return w;
                        }
                    };
                    console.error('✅ EN stemmer (natural) initialized');
                }
            }
            catch { }
        }).catch(() => { });
        const ruCandidates = [
            'russian-porter-stemmer',
            'russian-stemmer',
            'stemmer-ru',
            '@nlpjs/lang-ru'
        ];
        for (const pkg of ruCandidates) {
            import(pkg as any).then((mod: any) => {
                try {
                    let fn: ((w: string) => string) | undefined;
                    if (typeof mod?.stem === 'function')
                        fn = mod.stem;
                    else if (typeof mod?.default === 'function')
                        fn = mod.default;
                    else if (mod?.default && typeof mod.default.stem === 'function')
                        fn = mod.default.stem;
                    if (fn) {
                        this.ruStemFn = (w: string) => { try {
                            return fn!(w);
                        }
                        catch {
                            return w;
                        } };
                        console.error(`✅ RU stemmer initialized from ${pkg}`);
                    }
                }
                catch { }
            }).catch(() => { });
        }
    }
    private extractRelevantSnippet(text: string, query: string, maxLength: number = 300): string {
        if (!text || text.length <= maxLength)
            return text;
        const queryWords = this.extractQueryWords(query);
        let bestPosition = 0;
        let maxMatches = 0;
        const windowSize = maxLength;
        for (let i = 0; i <= text.length - windowSize; i += Math.floor(windowSize / 3)) {
            const window = text.substring(i, i + windowSize).toLowerCase();
            let matches = 0;
            for (const word of queryWords) {
                const regex = new RegExp(this.escapeRegex(word), 'gi');
                const wordMatches = window.match(regex);
                if (wordMatches)
                    matches += wordMatches.length;
            }
            if (matches > maxMatches) {
                maxMatches = matches;
                bestPosition = i;
            }
        }
        let snippet = text.substring(bestPosition, bestPosition + maxLength);
        if (bestPosition > 0)
            snippet = '...' + snippet;
        if (bestPosition + maxLength < text.length)
            snippet = snippet + '...';
        return snippet;
    }
    private findLinkedNotes(noteId: string, maxDepth: number = 2): ObsidianNote[] {
        if (!this.indexData || maxDepth <= 0)
            return [];
        const visited = new Set<string>();
        const linkedNotes: ObsidianNote[] = [];
        const queue: {
            note: ObsidianNote;
            depth: number;
        }[] = [];
        const startNote = this.indexData.find(note => note.id === noteId || note.path === noteId || note.title === noteId);
        if (!startNote)
            return [];
        queue.push({ note: startNote, depth: 0 });
        visited.add(startNote.id || startNote.path);
        while (queue.length > 0) {
            const { note, depth } = queue.shift()!;
            if (depth > 0) {
                linkedNotes.push(note);
            }
            if (depth < maxDepth && note.links) {
                for (const link of note.links) {
                    if (!visited.has(link)) {
                        const linkedNote = this.indexData.find(n => n.id === link || n.path === link || n.title === link);
                        if (linkedNote) {
                            visited.add(linkedNote.id || linkedNote.path);
                            queue.push({ note: linkedNote, depth: depth + 1 });
                        }
                    }
                }
            }
            if (depth < maxDepth) {
                const backlinks = this.indexData.filter(n => n.links && n.links.some(link => link === (note.id || note.path || note.title)) && !visited.has(n.id || n.path));
                for (const backlink of backlinks) {
                    visited.add(backlink.id || backlink.path);
                    queue.push({ note: backlink, depth: depth + 1 });
                }
            }
        }
        return linkedNotes;
    }
    private searchWithLinks(query: string, baseResults: SearchResult[], includeLinked: boolean = true): SearchResult[] {
        if (!includeLinked || baseResults.length === 0)
            return baseResults;
        const highQualityResults = baseResults.filter(r => r.score < 0.2);
        if (highQualityResults.length === 0) {
            console.error(`🔗 Skipping linked notes: no high-quality base results found`);
            return baseResults;
        }
        const enhancedResults: SearchResult[] = [...baseResults];
        const addedIds = new Set(baseResults.map(r => r.id));
        for (const result of baseResults.slice(0, 2)) {
            const linkedNotes = this.findLinkedNotes(result.id, 1);
            for (const linkedNote of linkedNotes.slice(0, 1)) {
                const linkedId = linkedNote.id || linkedNote.path;
                if (!addedIds.has(linkedId)) {
                    addedIds.add(linkedId);
                    const linkedResult: SearchResult = {
                        id: linkedId,
                        title: `🔗 ${this.highlightMatches(linkedNote.title || 'Untitled', query)}`,
                        description: `Linked with: \"${result.title.replace(/\*\*/g, '')}\" | ${this.highlightMatches(linkedNote.description || '', query)}`,
                        path: linkedNote.path,
                        lastModified: linkedNote.lastModified || '',
                        score: result.score * 0.7,
                        type: 'linked_note',
                        content_preview: this.highlightMatches(this.extractRelevantSnippet(linkedNote.content || '', query, 200), query),
                        tags: linkedNote.tags,
                        links: linkedNote.links,
                        confidence: 'medium'
                    };
                    enhancedResults.push(linkedResult);
                }
            }
        }
        return enhancedResults.sort((a, b) => {
            if (a.type === 'fuse_match' && b.type === 'linked_note')
                return -1;
            if (a.type === 'linked_note' && b.type === 'fuse_match')
                return 1;
            return b.score - a.score;
        });
    }
    private debugAdvancedFilter(note: ObsidianNote, parsedQuery: ParsedQuery): boolean {
        const searchableText = [
            note.title || '',
            note.description || '',
            note.content || note.content_preview || '',
            note.path,
            (note.tags || []).join(' ')
        ].join(' ').toLowerCase();
        console.error(`🔍 Searchable text sample: "${searchableText.substring(0, 100)}..."`);
        for (const phrase of parsedQuery.exactPhrases) {
            const found = searchableText.includes(phrase);
            console.error(`🔍 Exact phrase "${phrase}": ${found}`);
            if (!found)
                return false;
        }
        for (const required of parsedQuery.requiredTerms) {
            const found = searchableText.includes(required);
            console.error(`🔍 Required term "${required}": ${found}`);
            if (!found)
                return false;
        }
        for (const excluded of parsedQuery.excludedTerms) {
            const found = searchableText.includes(excluded);
            console.error(`🔍 Excluded term "${excluded}": ${found} (should be false)`);
            if (found)
                return false;
        }
        for (const fieldQuery of parsedQuery.fieldQueries) {
            let fieldValue = '';
            switch (fieldQuery.field) {
                case 'title':
                    fieldValue = (note.title || '').toLowerCase();
                    break;
                case 'path':
                    fieldValue = note.path.toLowerCase();
                    break;
                case 'tags':
                    fieldValue = (note.tags || []).join(' ').toLowerCase();
                    break;
                case 'aliases':
                    fieldValue = (note.aliases || []).join(' ').toLowerCase();
                    break;
                case 'type':
                    fieldValue = (note.type || '').toLowerCase();
                    break;
                case 'content':
                    fieldValue = (note.content || note.content_preview || '').toLowerCase();
                    break;
                default:
                    if (fieldQuery.field.startsWith('fm.')) {
                        const fmKey = fieldQuery.field.slice(3);
                        try {
                            const { frontmatter } = this.parseFrontmatterAndBody(note.content || '');
                            const raw = frontmatter?.[fmKey];
                            if (Array.isArray(raw))
                                fieldValue = raw.join(' ').toLowerCase();
                            else if (raw != null)
                                fieldValue = String(raw).toLowerCase();
                        }
                        catch { }
                    }
            }
            const found = fieldValue.includes(fieldQuery.value);
            console.error(`🔍 Field ${fieldQuery.field}:"${fieldQuery.value}": ${found} (field value: "${fieldValue.substring(0, 50)}...")`);
            if (!found)
                return false;
        }
        return true;
    }
    private filterByAdvancedQuery(results: SearchResult[], parsedQuery: ParsedQuery, originalNotes: ObsidianNote[]): SearchResult[] {
        return results.filter(result => {
            const note = originalNotes.find(n => (n.id || n.path) === result.id);
            if (!note)
                return false;
            const searchableText = [
                note.title || '',
                note.description || '',
                note.content || note.content_preview || '',
                note.path,
                (note.tags || []).join(' ')
            ].join(' ').toLowerCase();
            for (const phrase of parsedQuery.exactPhrases) {
                if (!searchableText.includes(phrase))
                    return false;
            }
            for (const required of parsedQuery.requiredTerms) {
                if (!searchableText.includes(required))
                    return false;
            }
            for (const excluded of parsedQuery.excludedTerms) {
                if (searchableText.includes(excluded))
                    return false;
            }
            for (const fieldQuery of parsedQuery.fieldQueries) {
                let fieldValue = '';
                switch (fieldQuery.field) {
                    case 'title':
                        fieldValue = (note.title || '').toLowerCase();
                        break;
                    case 'path':
                        fieldValue = note.path.toLowerCase();
                        break;
                    case 'tags':
                        fieldValue = (note.tags || []).join(' ').toLowerCase();
                        break;
                    case 'aliases':
                        fieldValue = (note.aliases || []).join(' ').toLowerCase();
                        break;
                    case 'type':
                        fieldValue = (note.type || '').toLowerCase();
                        break;
                    case 'content':
                        fieldValue = (note.content || note.content_preview || '').toLowerCase();
                        break;
                    default:
                        if (fieldQuery.field.startsWith('fm.')) {
                            const fmKey = fieldQuery.field.slice(3);
                            try {
                                const { frontmatter } = this.parseFrontmatterAndBody(note.content || '');
                                const raw = frontmatter?.[fmKey];
                                if (Array.isArray(raw))
                                    fieldValue = raw.join(' ').toLowerCase();
                                else if (raw != null)
                                    fieldValue = String(raw).toLowerCase();
                            }
                            catch { }
                        }
                }
                if (!fieldValue.includes(fieldQuery.value))
                    return false;
            }
            return true;
        });
    }
    private categorizeResults(results: SearchResult[]): Map<NoteCategory, SearchResult[]> {
        const categorized = new Map<NoteCategory, SearchResult[]>();
        Object.values(NoteCategory).forEach(category => {
            categorized.set(category, []);
        });
        for (const result of results) {
            const note = this.indexData.find(n => (n.id || n.path) === result.id);
            if (note) {
                const category = NoteCategorizer.categorize(note);
                categorized.get(category)!.push(result);
            }
        }
        return categorized;
    }
    private formatCategorizedResults(categorized: Map<NoteCategory, SearchResult[]>, limit: number): SearchResult[] {
        const formatted: SearchResult[] = [];
        let totalAdded = 0;
        const categoryPriority = [
            NoteCategory.DOCUMENTATION,
            NoteCategory.PROJECT_SPEC,
            NoteCategory.CODE_SAMPLES,
            NoteCategory.TUTORIAL,
            NoteCategory.REFERENCE,
            NoteCategory.TODO_TASKS,
            NoteCategory.PERSONAL_NOTES,
            NoteCategory.OTHER
        ];
        for (const category of categoryPriority) {
            const categoryResults = categorized.get(category) || [];
            if (categoryResults.length === 0)
                continue;
            for (const result of categoryResults) {
                if (totalAdded >= limit)
                    break;
                const enhancedResult = {
                    ...result,
                    description: `[${category}] ${result.description}`,
                    type: result.type === 'linked_note' ? 'linked_note' : 'categorized_result'
                };
                formatted.push(enhancedResult);
                totalAdded++;
            }
            if (totalAdded >= limit)
                break;
        }
        return formatted;
    }
    private getCacheKey(query: string, limit: number): string {
        return `${query.toLowerCase().trim()}:${limit}`;
    }
    private cleanExpiredCache(): void {
        const now = Date.now();
        for (const [key, entry] of this.searchCache.entries()) {
            if (now - entry.timestamp > this.CACHE_TTL) {
                this.searchCache.delete(key);
            }
        }
    }
    private evictLeastUsedCache(): void {
        if (this.searchCache.size < this.MAX_CACHE_SIZE)
            return;
        let minHitCount = Infinity;
        let keyToEvict = '';
        for (const [key, entry] of this.searchCache.entries()) {
            if (entry.hitCount < minHitCount) {
                minHitCount = entry.hitCount;
                keyToEvict = key;
            }
        }
        if (keyToEvict) {
            this.searchCache.delete(keyToEvict);
        }
    }
    private getCachedResult(query: string, limit: number): SearchResult[] | null {
        this.cleanExpiredCache();
        const key = this.getCacheKey(query, limit);
        const cached = this.searchCache.get(key);
        if (cached) {
            const now = Date.now();
            if (now - cached.timestamp <= this.CACHE_TTL) {
                cached.hitCount++;
                cached.timestamp = now;
                console.error(`⚡ Cache HIT for "${query}" (hits: ${cached.hitCount})`);
                return [...cached.results];
            }
            else {
                this.searchCache.delete(key);
            }
        }
        console.error(`💾 Cache MISS for "${query}"`);
        return null;
    }
    private setCachedResult(query: string, limit: number, results: SearchResult[]): void {
        const key = this.getCacheKey(query, limit);
        this.evictLeastUsedCache();
        this.searchCache.set(key, {
            results: [...results],
            timestamp: Date.now(),
            hitCount: 1
        });
        console.error(`💾 Cached results for "${query}" (cache size: ${this.searchCache.size}/${this.MAX_CACHE_SIZE})`);
    }
    private clearCache(): void {
        this.searchCache.clear();
        console.error(`🗑️ Search cache cleared`);
    }
    private recordSearchAnalytics(query: string, searchTime: number, resultsCount: number, hasAdvancedOperators: boolean, linkedNotesCount: number, categories: Map<NoteCategory, SearchResult[]>): void {
        this.searchStats.totalSearches++;
        const normalizedQuery = query.toLowerCase().trim();
        this.searchStats.popularQueries.set(normalizedQuery, (this.searchStats.popularQueries.get(normalizedQuery) || 0) + 1);
        const words = normalizedQuery.split(/\s+/).filter(w => w.length > 2);
        for (const word of words) {
            this.searchStats.popularWords.set(word, (this.searchStats.popularWords.get(word) || 0) + 1);
        }
        this.searchStats.avgSearchTime = (this.searchStats.avgSearchTime + searchTime) / 2;
        const hour = new Date().getHours();
        this.searchStats.searchesByHour[hour]++;
        if (hasAdvancedOperators) {
            this.searchStats.advancedOperatorsUsed++;
        }
        this.searchStats.linkedNotesFound += linkedNotesCount;
        for (const [category, results] of categories) {
            if (results.length > 0) {
                this.searchStats.categoriesFound.set(category, (this.searchStats.categoriesFound.get(category) || 0) + results.length);
            }
        }
    }
    private recordCacheHit(): void {
        this.searchStats.cacheHits++;
    }
    private getSearchStatistics(): string {
        const stats = this.searchStats;
        const cacheHitRate = stats.totalSearches > 0 ? ((stats.cacheHits / stats.totalSearches) * 100).toFixed(1) : '0';
        const topQueries = Array.from(stats.popularQueries.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([query, count]) => `"${query}": ${count}`)
            .join(', ');
        const topWords = Array.from(stats.popularWords.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([word, count]) => `${word}(${count})`)
            .join(', ');
        const peakHour = stats.searchesByHour.indexOf(Math.max(...stats.searchesByHour));
        return `
📊 SEARCH STATS:
🔍 Total searches: ${stats.totalSearches}
⚡ Cache Hit Rate: ${cacheHitRate}% (${stats.cacheHits}/${stats.totalSearches})
⏱️ Avg time: ${stats.avgSearchTime.toFixed(1)}ms
🕐 Peak hour: ${peakHour}:00 (${stats.searchesByHour[peakHour]} searches)
🔗 Linked notes found: ${stats.linkedNotesFound}
🔍 Advanced operators used: ${stats.advancedOperatorsUsed}
📈 Popular queries: ${topQueries || 'n/a'}
🏷️ Popular words: ${topWords || 'n/a'}
    `.trim();
    }
    public searchNotes(query: string, limit: number = DEFAULT_LIMIT, options?: {
        mode?: 'balanced' | 'taxonomy';
        includeLinked?: boolean;
    }): SearchResult[] {
        const mode = options?.mode || 'balanced';
        const includeLinked = options?.includeLinked !== false;
        if (!this.fuse || !this.indexData || this.indexData.length === 0) {
            console.error(`❌ Search engine not initialized`);
            return [];
        }
        const searchStartTime = Date.now();
        const cachedResults = this.getCachedResult(query, limit);
        if (cachedResults) {
            this.recordCacheHit();
            return cachedResults;
        }
        this.initializeFuse(mode);
        console.error(`🔍 Searching: "${query}" in ${this.indexData.length} notes [mode=${mode}]`);
        const parsedQuery = QueryParser.parse(query);
        const hasAdvancedOperators = parsedQuery.exactPhrases.length > 0 ||
            parsedQuery.requiredTerms.length > 0 ||
            parsedQuery.excludedTerms.length > 0 ||
            parsedQuery.fieldQueries.length > 0;
        if (hasAdvancedOperators) {
            console.error(`🔍 Advanced operators: phrases=${parsedQuery.exactPhrases.length}, required=${parsedQuery.requiredTerms.length}, excluded=${parsedQuery.excludedTerms.length}, fields=${parsedQuery.fieldQueries.length}`);
        }
        const searchTerms = [...parsedQuery.terms, ...parsedQuery.requiredTerms, ...parsedQuery.exactPhrases];
        const effectiveQuery = searchTerms.join(' ');
        let allResults: any[] = [];
        if (hasAdvancedOperators && searchTerms.length === 0) {
            console.error(`🔧 Advanced-only query: using full index as candidate set before advanced filtering`);
            allResults = this.indexData.map((note, index) => ({
                item: note,
                score: 0,
                refIndex: index
            }));
        }
        else {
            const expandedQueries = this.expandQueryWithSynonyms(effectiveQuery || query);
            for (const searchQuery of expandedQueries) {
                const results = this.fuse.search(searchQuery);
                allResults.push(...results);
            }
        }
        const uniqueResults = new Map();
        for (const result of allResults) {
            const id = result.item.id;
            if (!uniqueResults.has(id) || result.score < uniqueResults.get(id).score) {
                uniqueResults.set(id, result);
            }
        }
        const MIN_SCORE_THRESHOLD = 0.35;
        const qualitySortedResults = Array.from(uniqueResults.values())
            .filter((result: any) => {
            const score = result.score ?? 0;
            return score < MIN_SCORE_THRESHOLD;
        })
            .sort((a: any, b: any) => (a.score ?? 0) - (b.score ?? 0));
        console.error(`🎯 Quality filter: ${qualitySortedResults.length}/${uniqueResults.size} results passed (threshold: ${MIN_SCORE_THRESHOLD})`);
        const preLimitResults = (hasAdvancedOperators && searchTerms.length === 0)
            ? qualitySortedResults
            : qualitySortedResults.slice(0, limit);
        const searchResults: SearchResult[] = preLimitResults
            .map((result: any) => {
            const note = result.item as ObsidianNote;
            const score = result.score ?? 0;
            let type = 'fuse_match';
            let confidence = 'high';
            if (score > 0.3)
                confidence = 'medium';
            if (score > 0.6)
                confidence = 'low';
            const originalContent = note.content || '';
            const normalizedQuery = this.normalizeQuery(query);
            const smartSnippet = this.extractRelevantSnippet(originalContent, normalizedQuery || query, 300);
            const highlightedSnippet = this.highlightMatches(smartSnippet, normalizedQuery || query);
            let finalScore = score;
            if ((mode as any) === 'semantic') {
                const qWords = this.extractQueryWords(normalizedQuery || query);
                let matches = 0;
                const lc = (originalContent || '').toLowerCase();
                for (const w of qWords) {
                    if (!w || w.length < 2)
                        continue;
                    const re = new RegExp(this.escapeRegex(w), 'g');
                    const m = lc.match(re);
                    if (m)
                        matches += Math.min(5, m.length);
                }
                const sem = matches > 0 ? Math.min(0.25, 0.7 / (matches + 1)) : 0.7;
                finalScore = Math.min(score, sem);
                if (finalScore < score)
                    confidence = 'high';
            }
            return {
                id: note.id || 'unknown',
                title: this.highlightMatches(note.title || 'Untitled', normalizedQuery || query),
                description: this.highlightMatches(note.description || '', normalizedQuery || query),
                path: note.path,
                lastModified: note.lastModified || '',
                score: finalScore,
                type,
                content_preview: highlightedSnippet,
                tags: note.tags,
                links: note.links,
                confidence
            };
        });
        console.error(`✨ Found ${searchResults.length} results with Fuse.js`);
        let filteredResults = searchResults;
        if (hasAdvancedOperators) {
            filteredResults = this.filterByAdvancedQuery(searchResults, parsedQuery, this.indexData);
            console.error(`🔍 Advanced filtering: ${filteredResults.length}/${searchResults.length} results passed`);
        }
        if (hasAdvancedOperators && searchTerms.length === 0) {
            filteredResults = filteredResults.slice(0, limit);
        }
        const enhancedResults = this.searchWithLinks(query, filteredResults, includeLinked);
        console.error(`🔗 Enhanced with linked notes: ${enhancedResults.length} total results (${enhancedResults.length - filteredResults.length} linked notes added)`);
        const categorized = this.categorizeResults(enhancedResults);
        const finalResults = this.formatCategorizedResults(categorized, limit);
        const categoryStats: string[] = [];
        for (const [category, results] of categorized) {
            if (results.length > 0) {
                categoryStats.push(`${category}: ${results.length}`);
            }
        }
        console.error(`📊 Results categorized: ${finalResults.length} total results. Categories: ${categoryStats.join(', ')}`);
        this.setCachedResult(query, limit, finalResults);
        const searchTime = Date.now() - searchStartTime;
        const linkedNotesCount = enhancedResults.length - filteredResults.length;
        this.recordSearchAnalytics(query, searchTime, finalResults.length, hasAdvancedOperators, linkedNotesCount, categorized);
        if (this.searchStats.totalSearches % 10 === 0) {
            console.error(`\n${this.getSearchStatistics()}\n`);
        }
        return finalResults;
    }
    public getFullNoteContent(noteId: string): string | null {
        let resolvedPath: string | undefined;
        try {
            const r = this.resolveNotePublic(noteId);
            if (r && r.exists && r.path)
                resolvedPath = r.path;
        }
        catch { }
        const note = resolvedPath
            ? this.indexData.find(n => n.path === resolvedPath) || this.getNote(noteId)
            : this.getNote(noteId);
        if (note && note.fullPath) {
            try {
                const fullContent = readFileSync(note.fullPath, 'utf-8');
                console.error(`📄 Successfully read full content for indexed note: ${note.title} (${fullContent.length} chars)`);
                return fullContent;
            }
            catch (error) {
                console.error(`❌ Error reading indexed note ${noteId}:`, error);
                return note.content || note.content_preview || null;
            }
        }
        try {
            const rel = noteId.replace(/^\/+/, '');
            const relWithExt = rel.toLowerCase().endsWith('.md') ? rel : `${rel}.md`;
            const absolutePath = path.resolve(this.vaultPath, relWithExt);
            if (!absolutePath.startsWith(path.resolve(this.vaultPath))) {
                console.error(`❌ Rejected path outside vault: ${noteId}`);
                return null;
            }
            if (existsSync(absolutePath)) {
                const fullContent = readFileSync(absolutePath, 'utf-8');
                console.error(`📄 Successfully read full content by path: ${relWithExt} (${fullContent.length} chars)`);
                return fullContent;
            }
        }
        catch (error) {
            console.error(`❌ Fallback read error for ${noteId}:`, error);
        }
        return null;
    }
    public writeNote(options: {
        filePath: string;
        content: string;
        writeMode?: 'create' | 'overwrite' | 'append';
        frontmatter?: Record<string, any>;
        heading?: string;
        ensureMdExtension?: boolean;
        createMissingFolders?: boolean;
    }): {
        absolutePath: string;
        relativePath: string;
        bytesWritten: number;
        created: boolean;
        overwritten: boolean;
        appended: boolean;
    } {
        const { filePath, content, writeMode = 'create', frontmatter, heading, ensureMdExtension = true, createMissingFolders = true } = options;
        if (!filePath || !content) {
            throw new Error('filePath and content are required');
        }
        const normalizedRel = filePath.replace(/^\/+/, '');
        const relWithExt = ensureMdExtension && !normalizedRel.toLowerCase().endsWith('.md')
            ? `${normalizedRel}.md`
            : normalizedRel;
        const vaultRoot = path.resolve(this.vaultPath);
        const absolutePath = path.resolve(vaultRoot, relWithExt);
        if (!absolutePath.startsWith(vaultRoot)) {
            throw new Error(`Resolved path escapes vault root: ${filePath}`);
        }
        if (createMissingFolders) {
            const dir = path.dirname(absolutePath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
        }
        const fileExists = existsSync(absolutePath);
        if (writeMode === 'create' && fileExists) {
            throw new Error(`File already exists: ${relWithExt}. Use overwrite or append.`);
        }
        if (writeMode === 'overwrite' || (writeMode === 'create' && !fileExists)) {
            const finalContent = this.buildMarkdownWithFrontmatter(frontmatter, content);
            try {
                const parsed = this.parseFrontmatterAndBody(finalContent);
                this.enforcePolicy(relWithExt, parsed.frontmatter || {});
            }
            catch (e) {
                if (this.policyMode === 'block')
                    throw e;
                else
                    console.error('⚠️ policy warn:', e);
            }
            writeFileSync(absolutePath, finalContent, { encoding: 'utf-8' });
            try {
                this.scheduleIndexSingleFile(relWithExt);
            }
            catch { }
            return {
                absolutePath,
                relativePath: relWithExt,
                bytesWritten: Buffer.byteLength(finalContent, 'utf-8'),
                created: !fileExists,
                overwritten: fileExists,
                appended: false
            };
        }
        let bytesWritten = 0;
        if (!fileExists) {
            const initial = this.buildMarkdownWithFrontmatter(frontmatter, heading ? `## ${heading}\n\n${content}` : content);
            writeFileSync(absolutePath, initial, { encoding: 'utf-8' });
            bytesWritten = Buffer.byteLength(initial, 'utf-8');
            return {
                absolutePath,
                relativePath: relWithExt,
                bytesWritten,
                created: true,
                overwritten: false,
                appended: true
            };
        }
        const original = readFileSync(absolutePath, 'utf-8');
        let updated = original;
        if (heading && heading.trim().length > 0) {
            updated = this.appendUnderHeading(original, heading.trim(), content);
        }
        else {
            const needsNewline = !original.endsWith('\n');
            updated = original + (needsNewline ? '\n\n' : '\n') + content + '\n';
        }
        writeFileSync(absolutePath, updated, { encoding: 'utf-8' });
        bytesWritten = Buffer.byteLength(updated, 'utf-8') - Buffer.byteLength(original, 'utf-8');
        try {
            this.scheduleIndexSingleFile(relWithExt);
        }
        catch { }
        return {
            absolutePath,
            relativePath: relWithExt,
            bytesWritten,
            created: false,
            overwritten: false,
            appended: true
        };
    }
    private buildMarkdownWithFrontmatter(frontmatter: Record<string, any> | undefined, content: string): string {
        if (!frontmatter || Object.keys(frontmatter).length === 0) {
            return content;
        }
        try {
            const yamlText = YAML.stringify(frontmatter, { indent: 2, lineWidth: 0 });
            const fm = yamlText.endsWith('\n') ? yamlText : yamlText + '\n';
            return `---\n${fm}---\n\n${content}`;
        }
        catch (e) {
            const jsonLike = Object.entries(frontmatter)
                .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
                .join('\n');
            return `---\n${jsonLike}\n---\n\n${content}`;
        }
    }
    private appendUnderHeading(original: string, heading: string, addition: string): string {
        const lines = original.split('\n');
        const headingRegex = new RegExp(`^#{1,6}\\s+${this.escapeRegex(heading)}\\s*$`, 'i');
        const index = lines.findIndex(line => headingRegex.test(line));
        if (index === -1) {
            const suffix = (original.endsWith('\n') ? '' : '\n') + `\n## ${heading}\n\n${addition}\n`;
            return original + suffix;
        }
        let insertAt = index + 1;
        while (insertAt < lines.length && lines[insertAt].trim() === '')
            insertAt++;
        const before = lines.slice(0, insertAt).join('\n');
        const after = lines.slice(insertAt).join('\n');
        const middle = (before.endsWith('\n') ? '' : '\n') + '\n' + addition + '\n';
        return before + middle + (after ? '\n' + after : '');
    }
    private parseFrontmatterAndBody(original: string): {
        frontmatter: Record<string, any>;
        body: string;
    } {
        const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
        const match = original.match(fmRegex);
        if (!match) {
            return { frontmatter: {}, body: original };
        }
        const fmText = match[1];
        const body = original.slice(match[0].length);
        try {
            const parsed = YAML.parse(fmText) as unknown;
            const fm = (parsed && typeof parsed === 'object') ? (parsed as Record<string, any>) : {};
            return { frontmatter: fm, body };
        }
        catch {
            return { frontmatter: {}, body };
        }
    }
    private policyDefaults(): GraphPolicy {
        return {
            mode: (process.env.MCP_GRAPH_POLICY_MODE === 'block' ? 'block' : 'warn'),
            links: { parentKey: 'part_of', otherKeys: ['related', 'depends_on', 'blocks'], relationsHeading: 'Relations' },
            types: {
                hub: { required: ['title', 'type'] },
                project: { required: ['title', 'type', 'part_of'], mustHaveParent: true },
                index: { required: ['title', 'type', 'part_of'], mustHaveParent: true },
                feature: { required: ['title', 'type', 'part_of', 'status'], mustHaveParent: true },
                solution: { required: ['title', 'type', 'part_of'], mustHaveParent: true },
                runbook: { required: ['title', 'type', 'part_of'], mustHaveParent: true },
                benchmark: { required: ['title', 'type', 'part_of'], mustHaveParent: true },
                domain: { required: ['title', 'type', 'part_of'], mustHaveParent: true },
                topic: { required: ['title', 'type', 'part_of'], mustHaveParent: true }
            }
        };
    }
    public loadGraphPolicy(): void {
        const root = path.resolve(this.vaultPath);
        const candidateJson = path.join(root, 'graph', '_graph_policy.json');
        const candidateYaml = path.join(root, 'graph', '.graph-policy.yml');
        let policy: GraphPolicy = this.policyDefaults();
        let source = '[defaults]';
        try {
            if (existsSync(candidateJson)) {
                const txt = readFileSync(candidateJson, 'utf-8');
                const obj = JSON.parse(txt);
                if (obj && typeof obj === 'object')
                    policy = { ...policy, ...obj };
                try {
                    this.graphPolicyMtime = statSync(candidateJson).mtimeMs;
                }
                catch { }
                source = candidateJson;
            }
            else if (existsSync(candidateYaml)) {
                const txt = readFileSync(candidateYaml, 'utf-8');
                const obj = YAML.parse(txt) as any;
                if (obj && typeof obj === 'object')
                    policy = { ...policy, ...obj };
                try {
                    this.graphPolicyMtime = statSync(candidateYaml).mtimeMs;
                }
                catch { }
                source = candidateYaml;
            }
        }
        catch (e) {
            console.error('⚠️ Failed to read graph policy, using defaults:', e);
        }
        this.graphPolicyPath = source;
        this.graphPolicy = policy;
        this.policyMode = (policy.mode === 'block' ? 'block' : 'warn');
        this.parentKey = policy.links?.parentKey || 'part_of';
        this.relationsHeading = policy.links?.relationsHeading || 'Relations';
        console.error(`🔒 Graph policy loaded (mode=${this.policyMode}) from ${source}`);
    }
    private validateNoteAgainstPolicy(filePath: string, fm: Record<string, any>): string[] {
        const issues: string[] = [];
        const t = String(fm?.type || '').toLowerCase();
        const spec = (this.graphPolicy.types || {})[t];
        if (!spec)
            return issues;
        for (const k of (spec.required || [])) {
            const v = (fm as any)[k];
            if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0))
                issues.push(`missing-required:${k}`);
        }
        const parentVal = (fm as any)[this.parentKey];
        const parents = Array.isArray(parentVal) ? parentVal : (parentVal ? [parentVal] : []);
        if (spec.mustHaveParent && parents.length === 0)
            issues.push('missing-parent');
        if (!spec.allowMultipleParents && parents.length > 1)
            issues.push('multiple-parents');
        if (parents.length > 0 && (spec.allowedParentTypes || spec.allowedParentTitles || spec.allowedParentPathIncludes)) {
            const getParentInfo = (wikilinkOrKey: string): {
                type?: string;
                title?: string;
                path?: string;
            } => {
                const key = (wikilinkOrKey || '').replace(/^\[\[|\]\]$/g, '').split('#')[0];
                const p = this.resolveNoteKeyToPath(key) || key;
                let content = '';
                const note = this.indexData.find(n => n.path === p);
                if (note)
                    content = note.content || note.content_preview || '';
                else {
                    try {
                        const abs = path.resolve(this.vaultPath, p.toLowerCase().endsWith('.md') ? p : `${p}.md`);
                        if (existsSync(abs))
                            content = readFileSync(abs, 'utf-8');
                    }
                    catch { }
                }
                if (!content)
                    return { path: p };
                const parsed = this.parseFrontmatterAndBody(content);
                const pt = String(parsed.frontmatter?.type || '').toLowerCase();
                const tt = String(parsed.frontmatter?.title || '');
                return { type: pt, title: tt, path: p };
            };
            for (const par of parents) {
                const info = getParentInfo(String(par));
                if (spec.allowedParentTypes && spec.allowedParentTypes.length > 0) {
                    if (!info.type || !spec.allowedParentTypes.includes(info.type)) {
                        issues.push(`invalid-parent-type:${info.type || 'unknown'} expected:${spec.allowedParentTypes.join('|')}`);
                    }
                }
                if (spec.allowedParentTitles && spec.allowedParentTitles.length > 0) {
                    if (!info.title || !spec.allowedParentTitles.includes(info.title)) {
                        issues.push(`invalid-parent-title:${info.title || 'unknown'} expected:${spec.allowedParentTitles.join('|')}`);
                    }
                }
                if (spec.allowedParentPathIncludes && spec.allowedParentPathIncludes.length > 0) {
                    const pathOk = info.path && spec.allowedParentPathIncludes.some(s => (info.path as string).includes(s));
                    if (!pathOk)
                        issues.push(`invalid-parent-path:${info.path || 'unknown'} must-include:${spec.allowedParentPathIncludes.join('|')}`);
                }
            }
        }
        return issues;
    }
    private enforcePolicy(filePath: string, fm: Record<string, any>): void {
        const issues = this.validateNoteAgainstPolicy(filePath, fm);
        if (issues.length === 0)
            return;
        const msg = `Graph policy violation in ${filePath}:\n- ${issues.join('\n- ')}`;
        if (this.policyMode === 'block')
            throw new Error(msg);
        else
            console.error('⚠️', msg);
    }
    public getGraphPolicyPublic(): {
        mode: string;
        parentKey: string;
        relationsHeading: string;
        path: string;
        policy: GraphPolicy;
    } {
        return { mode: this.policyMode, parentKey: this.parentKey, relationsHeading: this.relationsHeading, path: this.graphPolicyPath || 'defaults', policy: this.graphPolicy };
    }
    public parseFrontmatterPublic(content: string): {
        frontmatter: Record<string, any>;
        body: string;
    } { return this.parseFrontmatterAndBody(content); }
    public validateAgainstPolicyPublic(path: string, fm: Record<string, any>): string[] { return this.validateNoteAgainstPolicy(path, fm); }
    public createNode(options: {
        filePath: string;
        title?: string;
        type?: string;
        properties?: Record<string, any>;
        content?: string;
        ensureMdExtension?: boolean;
        createMissingFolders?: boolean;
    }) {
        const { filePath, title, type, properties, content = '', ensureMdExtension = true, createMissingFolders = true } = options;
        const fm: Record<string, any> = { ...(properties || {}) };
        if (title)
            fm.title = title;
        if (type)
            fm.type = type;
        return this.writeNote({ filePath, content, writeMode: 'create', frontmatter: fm, ensureMdExtension, createMissingFolders });
    }
    public linkNotes(options: {
        fromPath: string;
        toPath: string;
        relation?: string;
        mode?: 'property' | 'body' | 'both';
        bidirectional?: boolean;
        heading?: string;
    }) {
        const defaultRel = this.graphPolicy.links?.defaultRelation || 'related';
        const { fromPath, toPath, relation = defaultRel, mode = 'both', bidirectional = true, heading = this.relationsHeading || 'Relations' } = options;
        const toWikilink = this.toWikiLink(toPath);
        const fromWikilink = this.toWikiLink(fromPath);
        const updates: Array<() => void> = [];
        if (mode === 'property' || mode === 'both') {
            updates.push(() => this.upsertLinkInFrontmatter(fromPath, relation, toWikilink));
            if (bidirectional)
                updates.push(() => this.upsertLinkInFrontmatter(toPath, relation, fromWikilink));
        }
        if (mode === 'body' || mode === 'both') {
            updates.push(() => this.appendRelationBody(fromPath, heading, toWikilink));
            if (bidirectional)
                updates.push(() => this.appendRelationBody(toPath, heading, fromWikilink));
        }
        for (const fn of updates)
            fn();
        return { ok: true, fromPath, toPath, relation, mode, bidirectional };
    }
    private toWikiLink(relPath: string): string {
        const withExt = relPath.toLowerCase().endsWith('.md') ? relPath : `${relPath}.md`;
        const noteName = path.basename(withExt, '.md');
        return `[[${noteName}]]`;
    }
    private upsertLinkInFrontmatter(filePath: string, relation: string, wikilink: string): void {
        const vaultRoot = path.resolve(this.vaultPath);
        const relWithExt = filePath.toLowerCase().endsWith('.md') ? filePath : `${filePath}.md`;
        const absolutePath = path.resolve(vaultRoot, relWithExt.replace(/^\/+/, ''));
        if (!absolutePath.startsWith(vaultRoot))
            throw new Error('Path escape detected');
        let original = '';
        if (existsSync(absolutePath)) {
            original = readFileSync(absolutePath, 'utf-8');
        }
        else {
            writeFileSync(absolutePath, this.buildMarkdownWithFrontmatter({}, ''), { encoding: 'utf-8' });
            original = readFileSync(absolutePath, 'utf-8');
        }
        const { frontmatter: obj, body } = this.parseFrontmatterAndBody(original);
        const list = Array.isArray(obj[relation]) ? obj[relation] : (obj[relation] ? [obj[relation]] : []);
        if (!list.includes(wikilink))
            list.push(wikilink);
        obj[relation] = list;
        const newContent = this.buildMarkdownWithFrontmatter(obj, body.trimStart());
        try {
            this.enforcePolicy(relWithExt, obj);
        }
        catch (e) {
            if (this.policyMode === 'block')
                throw e;
            else
                console.error('⚠️ policy warn:', e);
        }
        writeFileSync(absolutePath, newContent, { encoding: 'utf-8' });
        try {
            this.scheduleIndexSingleFile(relWithExt);
        }
        catch { }
    }
    private appendRelationBody(filePath: string, heading: string, wikilink: string): void {
        const vaultRoot = path.resolve(this.vaultPath);
        const relWithExt = filePath.toLowerCase().endsWith('.md') ? filePath : `${filePath}.md`;
        const absolutePath = path.resolve(vaultRoot, relWithExt.replace(/^\/+/, ''));
        if (!absolutePath.startsWith(vaultRoot))
            throw new Error('Path escape detected');
        if (!existsSync(absolutePath)) {
            writeFileSync(absolutePath, `## ${heading}\n\n${wikilink}\n`, { encoding: 'utf-8' });
            try {
                this.scheduleIndexSingleFile(relWithExt);
            }
            catch { }
            return;
        }
        const original = readFileSync(absolutePath, 'utf-8');
        const lines = original.split('\n');
        const headingRegex = new RegExp(`^#{1,6}\\s+${this.escapeRegex(heading)}\\s*$`, 'i');
        const idx = lines.findIndex(line => headingRegex.test(line));
        if (idx !== -1) {
            let end = idx + 1;
            while (end < lines.length && !/^#{1,6}\s+/.test(lines[end]))
                end++;
            const section = lines.slice(idx + 1, end).join('\n');
            if (section.includes(wikilink)) {
                return;
            }
        }
        const updated = this.appendUnderHeading(original, heading, wikilink);
        writeFileSync(absolutePath, updated, { encoding: 'utf-8' });
        try {
            this.scheduleIndexSingleFile(relWithExt);
        }
        catch { }
    }
    public upsertFrontmatter(options: {
        filePath: string;
        set?: Record<string, any>;
        removeKeys?: string[];
        ensureMdExtension?: boolean;
        createMissingFolders?: boolean;
    }) {
        const { filePath, set, removeKeys, ensureMdExtension = true, createMissingFolders = true } = options;
        const vaultRoot = path.resolve(this.vaultPath);
        const relWithExt = ensureMdExtension && !filePath.toLowerCase().endsWith('.md') ? `${filePath}.md` : filePath;
        const absolutePath = path.resolve(vaultRoot, relWithExt.replace(/^\/+/, ''));
        if (!absolutePath.startsWith(vaultRoot))
            throw new Error('Path escape detected');
        if (createMissingFolders) {
            const dir = path.dirname(absolutePath);
            if (!existsSync(dir))
                mkdirSync(dir, { recursive: true });
        }
        let original = existsSync(absolutePath) ? readFileSync(absolutePath, 'utf-8') : '';
        if (!original)
            original = this.buildMarkdownWithFrontmatter({}, '');
        const { frontmatter, body } = this.parseFrontmatterAndBody(original);
        if (set) {
            for (const [k, v] of Object.entries(set))
                frontmatter[k] = v;
        }
        if (removeKeys) {
            for (const k of removeKeys)
                delete frontmatter[k];
        }
        const newContent = this.buildMarkdownWithFrontmatter(frontmatter, body.trimStart());
        try {
            this.enforcePolicy(relWithExt, frontmatter);
        }
        catch (e) {
            if (this.policyMode === 'block')
                throw e;
            else
                console.error('⚠️ policy warn:', e);
        }
        writeFileSync(absolutePath, newContent, { encoding: 'utf-8' });
        try {
            this.scheduleIndexSingleFile(relWithExt);
        }
        catch { }
        return { absolutePath, relativePath: relWithExt };
    }
    public findUncategorizedNotes(options?: {
        limit?: number;
    }): Array<{
        path: string;
        title: string;
        reasons: string[];
    }> {
        const limit = options?.limit ?? 20;
        const results: Array<{
            path: string;
            title: string;
            reasons: string[];
            lastModified?: string;
        }> = [];
        for (const n of this.indexData) {
            if (n.path.startsWith('.obsidian/') || n.path.includes('/node_modules/'))
                continue;
            const content = n.content || n.content_preview || '';
            const { frontmatter } = this.parseFrontmatterAndBody(content);
            const fm = frontmatter || {};
            const reasons: string[] = [];
            const title = (fm.title || n.title || (n.path.split('/').pop() || '').replace(/\.md$/i, '')) as string;
            const canonPrefix = (this.graphPolicy.folders?.canonicalPrefix || 'graph/Knowledge Hub/');
            const inCanon = n.path.startsWith(canonPrefix);
            if (!fm || Object.keys(fm).length === 0)
                reasons.push('no-frontmatter');
            if (!fm.title)
                reasons.push('no-title');
            if (!fm.type)
                reasons.push('no-type');
            const isClass = String(fm.type || '').toLowerCase() === 'class';
            if (!isClass) {
                const parentKey = this.parentKey || 'part_of';
                const relHead = this.relationsHeading || 'Relations';
                const hasFmLink = Array.isArray((fm as any)[parentKey]) ? (fm as any)[parentKey].length > 0 : Boolean((fm as any)[parentKey]);
                const relHeadEsc = this.escapeRegex(relHead);
                const hasBodyLink = new RegExp(`(^|\\n)##\\s+${relHeadEsc}\\b[\\s\\S]*?\\[\\[.+?\\]\\]`, 'i').test(content);
                if (!hasFmLink && !hasBodyLink)
                    reasons.push('no-relations');
            }
            if (!inCanon)
                reasons.push('outside-canonical-folders');
            const serious = reasons.filter(r => ['no-frontmatter', 'no-type', 'no-title', 'outside-canonical-folders', 'no-relations'].includes(r));
            if (serious.length > 0) {
                if (!(isClass && inCanon && !serious.some(r => r !== 'outside-canonical-folders'))) {
                    results.push({ path: n.path, title, reasons: serious, lastModified: n.lastModified });
                }
            }
        }
        results.sort((a, b) => (new Date(b.lastModified || 0).getTime() - new Date(a.lastModified || 0).getTime()));
        return results.slice(0, limit).map(({ path, title, reasons }) => ({ path, title, reasons }));
    }
    private guessTypeByHeuristics(title: string, content: string): string {
        const t = `${title}\n${content}`.toLowerCase();
        if (/(обсидиан|templater|dataview|плагин|plugin)/i.test(t))
            return 'tool';
        if (/(психоактив|лекарств|фармаколог|антидепресс|этанол|этиловый спирт|alcohol|ethanol)/i.test(t))
            return 'drug';
        if (/(linux|bash|docker|git|http|api|node|typescript|python|regex)/i.test(t))
            return 'technology';
        return 'note';
    }
    public normalizeNoteBaseline(options: {
        filePath: string;
        dryRun?: boolean;
        forceParent?: boolean;
    }): {
        path: string;
        updatedKeys: string[];
        guessed: {
            title?: string;
            type?: string;
            aliases?: string[];
            tags?: string[];
            taxonomy?: string[];
        };
    } {
        const { filePath, dryRun = false, forceParent = false } = options;
        const vaultRoot = path.resolve(this.vaultPath);
        let relWithExt = filePath.toLowerCase().endsWith('.md') ? filePath : `${filePath}.md`;
        let abs = path.resolve(vaultRoot, relWithExt.replace(/^\/+/, ''));
        if (!abs.startsWith(vaultRoot))
            throw new Error('Path escape detected');
        if (!existsSync(abs)) {
            const base = path.basename(relWithExt).toLowerCase();
            const byExact = this.indexData.find(n => (n.path || '').toLowerCase() === relWithExt.toLowerCase());
            const byBase = byExact || this.indexData.find(n => path.basename(n.path || '').toLowerCase() === base);
            const titleNoExt = base.replace(/\.md$/i, '');
            const byTitle = byBase || this.indexData.find(n => (n.title || '').toLowerCase() === titleNoExt);
            if (byTitle) {
                relWithExt = byTitle.path;
                abs = path.resolve(vaultRoot, relWithExt.replace(/^\/+/, ''));
            }
        }
        if (!existsSync(abs))
            throw new Error(`File not found: ${relWithExt}`);
        const original = readFileSync(abs, 'utf-8');
        const { frontmatter, body } = this.parseFrontmatterAndBody(original);
        const currentFm = frontmatter || {} as Record<string, any>;
        let title = currentFm.title;
        if (!title) {
            const m = body.match(/^#\s+(.+)$/m);
            title = m ? m[1].trim() : path.basename(relWithExt, '.md');
        }
        let type = currentFm.type;
        if (!type)
            type = this.guessTypeByHeuristics(title as string, body);
        let tags: string[] = Array.isArray(currentFm.tags) ? currentFm.tags.slice() : (currentFm.tags ? [String(currentFm.tags)] : []);
        if (!tags.includes('autocaptured'))
            tags.push('autocaptured');
        let aliases: string[] = Array.isArray(currentFm.aliases) ? currentFm.aliases.slice() : (currentFm.aliases ? [String(currentFm.aliases)] : []);
        let taxonomy: string[] = Array.isArray(currentFm.taxonomy) ? currentFm.taxonomy.slice() : [];
        const baseline = {
            source: currentFm.source ?? 'ai',
            created_by: currentFm.created_by ?? 'ai',
            status: currentFm.status ?? 'draft',
            confidence: currentFm.confidence ?? 'medium'
        };
        const updated: Record<string, any> = {
            ...currentFm,
            ...baseline,
            title,
            type,
            tags,
            aliases,
            taxonomy
        };
        try {
            const parentKey = this.parentKey || 'part_of';
            const hasParent = Array.isArray((updated as any)[parentKey])
                ? ((updated as any)[parentKey] as any[]).length > 0
                : Boolean((updated as any)[parentKey]);
            const expectedParent = this.selfFolderIndexPathOf(relWithExt);
            const invalidExpected = expectedParent && /^graph\/graph\.md$/i.test(expectedParent);
            const setParent = (p: string) => {
                try {
                    this.ensureIndexNoteExists(p);
                }
                catch { }
                (updated as any)[parentKey] = this.toWikiLink(p);
            };
            if (!invalidExpected && expectedParent && expectedParent !== relWithExt) {
                if (!hasParent) {
                    setParent(expectedParent);
                }
                else if (forceParent) {
                    setParent(expectedParent);
                }
            }
        }
        catch (e) {
            console.error('⚠️ normalize-baseline: failed to infer part_of:', e);
        }
        const updatedKeys = Object.keys(updated).filter(k => currentFm[k] !== updated[k]);
        if (!dryRun) {
            const newContent = this.buildMarkdownWithFrontmatter(updated, body.trimStart());
            writeFileSync(abs, newContent, { encoding: 'utf-8' });
            try {
                this.indexSingleFile(relWithExt);
            }
            catch { }
        }
        return {
            path: relWithExt,
            updatedKeys,
            guessed: { title, type, aliases, tags, taxonomy }
        };
    }
    public unlinkNotes(options: {
        fromPath: string;
        toPath: string;
        relation?: string;
        mode?: 'property' | 'body' | 'both';
        bidirectional?: boolean;
        heading?: string;
    }) {
        const defaultRel = this.graphPolicy.links?.defaultRelation || 'related';
        const { fromPath, toPath, relation = defaultRel, mode = 'both', bidirectional = true, heading = this.relationsHeading || 'Relations' } = options;
        const toWikilink = this.toWikiLink(toPath);
        const fromWikilink = this.toWikiLink(fromPath);
        const updates: Array<() => void> = [];
        if (mode === 'property' || mode === 'both') {
            updates.push(() => this.removeLinkFromFrontmatter(fromPath, relation, toWikilink));
            if (bidirectional)
                updates.push(() => this.removeLinkFromFrontmatter(toPath, relation, fromWikilink));
        }
        if (mode === 'body' || mode === 'both') {
            updates.push(() => this.removeRelationInBody(fromPath, heading, toWikilink));
            if (bidirectional)
                updates.push(() => this.removeRelationInBody(toPath, heading, fromWikilink));
        }
        for (const fn of updates)
            fn();
        return { ok: true };
    }
    private removeLinkFromFrontmatter(filePath: string, relation: string, wikilink: string): void {
        const vaultRoot = path.resolve(this.vaultPath);
        const relWithExt = filePath.toLowerCase().endsWith('.md') ? filePath : `${filePath}.md`;
        const absolutePath = path.resolve(vaultRoot, relWithExt.replace(/^\/+/, ''));
        if (!absolutePath.startsWith(vaultRoot))
            throw new Error('Path escape detected');
        if (!existsSync(absolutePath))
            return;
        const original = readFileSync(absolutePath, 'utf-8');
        const { frontmatter, body } = this.parseFrontmatterAndBody(original);
        if (frontmatter[relation]) {
            const arr = Array.isArray(frontmatter[relation]) ? frontmatter[relation] : [frontmatter[relation]];
            const filtered = arr.filter((x: any) => x !== wikilink);
            if (filtered.length === 0)
                delete frontmatter[relation];
            else
                frontmatter[relation] = filtered;
            const newContent = this.buildMarkdownWithFrontmatter(frontmatter, body.trimStart());
            writeFileSync(absolutePath, newContent, { encoding: 'utf-8' });
            try {
                this.scheduleIndexSingleFile(relWithExt);
            }
            catch { }
        }
    }
    private removeRelationInBody(filePath: string, heading: string, wikilink: string): void {
        const vaultRoot = path.resolve(this.vaultPath);
        const relWithExt = filePath.toLowerCase().endsWith('.md') ? filePath : `${filePath}.md`;
        const absolutePath = path.resolve(vaultRoot, relWithExt.replace(/^\/+/, ''));
        if (!absolutePath.startsWith(vaultRoot))
            throw new Error('Path escape detected');
        if (!existsSync(absolutePath))
            return;
        const original = readFileSync(absolutePath, 'utf-8');
        const lines = original.split('\n');
        const headingRegex = new RegExp(`^#{1,6}\\s+${this.escapeRegex(heading)}\\s*$`, 'i');
        const idx = lines.findIndex(line => headingRegex.test(line));
        if (idx === -1)
            return;
        let end = idx + 1;
        while (end < lines.length && !/^#{1,6}\s+/.test(lines[end]))
            end++;
        const before = lines.slice(0, idx + 1);
        const section = lines.slice(idx + 1, end);
        const after = lines.slice(end);
        const filtered = section.filter(line => !line.includes(wikilink));
        const updated = [...before, ...filtered, ...after].join('\n');
        writeFileSync(absolutePath, updated, { encoding: 'utf-8' });
        try {
            this.scheduleIndexSingleFile(relWithExt);
        }
        catch { }
    }
    private normalizeNoteKey(key: string): string {
        const base = key.replace(/\\/g, '/').split('/').pop() || key;
        return base.replace(/\.md$/i, '').trim().toLowerCase();
    }
    private extractWikiLinks(content: string): string[] {
        const result: string[] = [];
        const regex = /\[\[([^\]]+)\]\]/g;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(content)) !== null) {
            const raw = m[1].split('#')[0].trim();
            if (raw)
                result.push(this.normalizeNoteKey(raw));
        }
        return [...new Set(result)];
    }
    private resolveNoteKeyToPath(key: string): string | null {
        const norm = this.normalizeNoteKey(key);
        const byPath = this.indexData.find(n => this.normalizeNoteKey(n.path) === norm);
        if (byPath)
            return byPath.path;
        const byTitle = this.indexData.find(n => this.normalizeNoteKey(n.title || '') === norm);
        if (byTitle)
            return byTitle.path;
        return null;
    }
    private getOutgoingPaths(fromPath: string): string[] {
        const note = this.indexData.find(n => n.path === fromPath);
        if (!note)
            return [];
        const keys = this.extractWikiLinks((note.content || note.content_preview || ''));
        const paths = keys.map(k => this.resolveNoteKeyToPath(k)).filter((p): p is string => !!p);
        const { frontmatter } = this.parseFrontmatterAndBody(note.content || '');
        for (const [k, v] of Object.entries(frontmatter)) {
            if (Array.isArray(v)) {
                for (const item of v) {
                    if (typeof item === 'string' && /\[\[[^\]]+\]\]/.test(item)) {
                        const key = this.normalizeNoteKey(item.replace(/^\[\[|\]\]$/g, '').split('#')[0]);
                        const p = this.resolveNoteKeyToPath(key);
                        if (p)
                            paths.push(p);
                    }
                }
            }
        }
        return [...new Set(paths)];
    }
    private getBacklinkPaths(toPath: string): string[] {
        const keyPath = toPath.toLowerCase().endsWith('.md') ? toPath : `${toPath}.md`;
        const set = this.backlinkIndex.get(keyPath);
        return set ? Array.from(set) : [];
    }
    private rebuildBacklinkIndex(): void {
        const newIndex: Map<string, Set<string>> = new Map();
        for (const n of this.indexData) {
            const edges = this.collectNoteEdges(n, true, true);
            for (const e of edges) {
                const tgt = e.target.toLowerCase().endsWith('.md') ? e.target : `${e.target}.md`;
                if (!newIndex.has(tgt))
                    newIndex.set(tgt, new Set());
                newIndex.get(tgt)!.add(n.path);
            }
        }
        this.backlinkIndex = newIndex;
    }
    private getNote(noteId: string): ObsidianNote | null {
        return this.indexData.find(note => note.id === noteId ||
            note.path === noteId ||
            note.title === noteId) || null;
    }
    private _loadSynonyms(): Record<string, string[]> {
        return {
            "код": ["code", "script", "программа", "исходник"],
            "функция": ["function", "метод", "процедура"],
            "класс": ["class", "объект", "структура"],
            "переменная": ["variable", "var", "значение"],
            "массив": ["array", "список", "коллекция"],
            "база": ["database", "db", "данные", "storage"],
            "сервер": ["server", "backend", "api"],
            "клиент": ["client", "frontend", "ui"],
            "тест": ["test", "проверка", "testing"],
            "документация": ["documentation", "docs", "описание"],
            "ошибка": ["error", "bug", "проблема", "исключение"],
            "конфиг": ["config", "configuration", "настройки"],
            "модуль": ["module", "компонент", "библиотека"],
            "интерфейс": ["interface", "api", "контракт"],
            "typescript": ["ts", "javascript", "js"]
        };
    }
    private _loadUserSynonymsFromVault(): Record<string, string[]> {
        try {
            const candidates = this.indexData.filter(n => {
                const p = (n.path || '').toLowerCase();
                const t = (n.title || '').toLowerCase();
                return p.endsWith('synonyms.md') || p.includes('синоним') || t.includes('synonyms') || t.includes('синоним');
            });
            const merged: Record<string, string[]> = {};
            for (const note of candidates) {
                const content = (note.content || note.content_preview || '');
                const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/i);
                if (jsonMatch) {
                    try {
                        const obj = JSON.parse(jsonMatch[1]);
                        for (const [k, v] of Object.entries(obj)) {
                            const key = String(k).toLowerCase();
                            const arr = Array.isArray(v) ? v.map(x => String(x).toLowerCase().trim()).filter(Boolean) : [];
                            merged[key] = [...new Set([...(merged[key] || []), ...arr])];
                        }
                    }
                    catch { }
                }
                const lines = content.split('\n');
                for (const line of lines) {
                    const m = line.match(/^\s*([^:#]+)\s*:\s*([^#]+)$/);
                    if (!m)
                        continue;
                    const key = m[1].trim().toLowerCase();
                    const vals = m[2].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
                    if (key && vals.length > 0) {
                        merged[key] = [...new Set([...(merged[key] || []), ...vals])];
                    }
                }
            }
            return merged;
        }
        catch {
            return {};
        }
    }
    private _initCategories(): Record<string, string[]> {
        return {
            "programming": ["код", "функция", "класс", "переменная", "массив"],
            "infrastructure": ["сервер", "база", "конфиг", "модуль"],
            "documentation": ["документация", "описание", "readme"],
            "testing": ["тест", "проверка", "testing"]
        };
    }
    public getNotePathFromId(noteId: string): string | null {
        const note = this.indexData.find(n => n.id === noteId || n.path === noteId || (n.title && n.title === noteId));
        if (note)
            return note.path;
        return this.resolveNoteKeyToPath(noteId);
    }
    public getOutgoingPathsPub(pathInput: string): string[] { return this.getOutgoingPaths(pathInput); }
    public getBacklinkPathsPub(pathInput: string): string[] { return this.getBacklinkPaths(pathInput); }
    public getIndexData(): ObsidianNote[] { return this.indexData; }
    public getVaultRoot(): string { return this.vaultPath; }
    public reindexFileIncremental(relPath: string): void { this.indexSingleFile(relPath); }
    private getCanonicalHubPath(): string {
        return this.graphPolicy.folders?.hubs?.defaultPath || 'graph/Knowledge Hub/Knowledge Hub.md';
    }
    private ensurePartOf(fromPath: string, toPath: string): void {
        const vaultRoot = path.resolve(this.vaultPath);
        const fromRel = fromPath.toLowerCase().endsWith('.md') ? fromPath : `${fromPath}.md`;
        const fromAbs = path.resolve(vaultRoot, fromRel.replace(/^\/+/, ''));
        if (!existsSync(fromAbs))
            return;
        const toWikilink = this.toWikiLink(toPath);
        this.upsertLinkInFrontmatter(fromPath, this.parentKey || 'part_of', toWikilink);
        this.appendRelationBody(fromPath, this.relationsHeading || 'Relations', toWikilink);
    }
    private removeRelatedToHubIfNotHub(filePath: string): void {
        const vaultRoot = path.resolve(this.vaultPath);
        const rel = filePath.toLowerCase().endsWith('.md') ? filePath : `${filePath}.md`;
        const abs = path.resolve(vaultRoot, rel.replace(/^\/+/, ''));
        if (!existsSync(abs))
            return;
        const hub = this.getCanonicalHubPath().replace(/\.md$/i, '');
        const hubWiki = this.toWikiLink(hub);
        if (rel === this.getCanonicalHubPath())
            return;
        const defaultRel = this.graphPolicy.links?.defaultRelation || 'related';
        this.removeLinkFromFrontmatter(rel, defaultRel, hubWiki);
        this.removeRelationInBody(rel, this.relationsHeading || 'Relations', hubWiki);
    }
    private parentIndexPathOf(notePath: string): string | null {
        const parts = notePath.replace(/\\/g, '/').split('/');
        if (parts.length < 3)
            return null;
        parts.pop();
        if (parts.length === 0)
            return null;
        const currentFolder = parts[parts.length - 1];
        if (parts.length < 2)
            return null;
        const parentFolder = parts[parts.length - 2];
        const parentPath = [...parts.slice(0, parts.length - 1), `${parentFolder}.md`].join('/');
        return parentPath;
    }
    private selfFolderIndexPathOf(notePath: string): string | null {
        const parts = notePath.replace(/\\/g, '/').split('/');
        if (parts.length < 2)
            return null;
        parts.pop();
        if (parts.length === 0)
            return null;
        const folder = parts[parts.length - 1];
        const indexPath = [...parts, `${folder}.md`].join('/');
        return indexPath;
    }
    private ensureIndexNoteExists(indexPath: string): void {
        const vaultRoot = path.resolve(this.vaultPath);
        const abs = path.resolve(vaultRoot, indexPath);
        const dir = path.dirname(abs);
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        if (!existsSync(abs)) {
            const title = path.basename(indexPath, '.md');
            const summaryHeading = this.graphPolicy.folders?.index?.summaryHeading || 'Summary';
            const relHeading = this.graphPolicy.folders?.index?.relationsHeading || this.relationsHeading || 'Relations';
            const content = `## ${summaryHeading}\nSection index note “${title}”.\n\n## ${relHeading}\n`;
            const fmType = this.graphPolicy.folders?.index?.noteType || 'class';
            const fm = { title, type: fmType } as Record<string, any>;
            const md = this.buildMarkdownWithFrontmatter(fm, content);
            writeFileSync(abs, md, { encoding: 'utf-8' });
            try {
                this.scheduleIndexSingleFile(indexPath);
            }
            catch { }
        }
    }
    public repairGraph(): {
        fixed: number;
    } {
        let fixed = 0;
        const hub = this.getCanonicalHubPath();
        const vaultRoot = path.resolve(this.vaultPath);
        const canonPrefix = (this.graphPolicy.folders?.canonicalPrefix || 'graph/Knowledge Hub/').replace(/^\/+|\/+$/g, '') + '/';
        const notes = this.indexData.map(n => n.path).filter(p => p.startsWith(canonPrefix) && p.endsWith('.md'));
        for (const p of notes) {
            if (p === hub)
                continue;
            const abs = path.resolve(vaultRoot, p);
            if (!existsSync(abs))
                continue;
            this.removeRelatedToHubIfNotHub(p);
            let current = p;
            while (true) {
                const parent = this.parentIndexPathOf(current);
                if (!parent)
                    break;
                this.ensureIndexNoteExists(parent);
                this.ensurePartOf(current, parent);
                fixed++;
                if (parent === hub)
                    break;
                current = parent;
            }
        }
        return { fixed };
    }
    public purgeSubtree(options: {
        pathPrefix: string;
        deleteNonMd?: boolean;
        dryRun?: boolean;
    }): {
        removedFiles: number;
        removedDirs: number;
        listedFiles?: string[];
        listedDirs?: string[];
    } {
        const { pathPrefix, deleteNonMd = false, dryRun = false } = options;
        const vaultRoot = path.resolve(this.vaultPath);
        const normPrefix = pathPrefix.replace(/^\/+|\/+$/g, '') + '/';
        const absPrefix = path.resolve(vaultRoot, normPrefix);
        if (!absPrefix.startsWith(vaultRoot))
            throw new Error('Path escapes vault root');
        if (!existsSync(absPrefix)) {
            return { removedFiles: 0, removedDirs: 0, listedFiles: [], listedDirs: [] };
        }
        const mdFiles = this.indexData
            .map(n => n.path)
            .filter(p => p.startsWith(normPrefix) && p.toLowerCase().endsWith('.md'))
            .sort((a, b) => b.split('/').length - a.split('/').length);
        const filesFs: string[] = [];
        const dirsFs: string[] = [];
        const walk = (dirAbs: string) => {
            const entries = readdirSync(dirAbs);
            for (const entry of entries) {
                const full = path.join(dirAbs, entry);
                const st = statSync(full);
                if (st.isDirectory()) {
                    dirsFs.push(full);
                    walk(full);
                }
                else if (st.isFile()) {
                    const rel = path.relative(vaultRoot, full).replace(/\\/g, '/');
                    if (entry.toLowerCase().endsWith('.md'))
                        filesFs.push(rel);
                    else if (deleteNonMd)
                        filesFs.push(rel);
                }
            }
        };
        walk(absPrefix);
        const allFiles = Array.from(new Set([...mdFiles, ...filesFs]));
        const allDirs = Array.from(new Set(dirsFs
            .map(d => path.relative(vaultRoot, d).replace(/\\/g, '/'))
            .sort((a, b) => b.split('/').length - a.split('/').length)));
        if (dryRun) {
            return { removedFiles: 0, removedDirs: 0, listedFiles: allFiles, listedDirs: allDirs };
        }
        let removedFiles = 0;
        for (const rel of allFiles) {
            try {
                const abs = path.resolve(vaultRoot, rel);
                if (existsSync(abs)) {
                    rmSync(abs);
                    removedFiles++;
                }
            }
            catch { }
        }
        if (removedFiles > 0) {
            const toRemoveSet = new Set(allFiles.filter(p => p.toLowerCase().endsWith('.md')));
            this.indexData = this.indexData.filter(n => !toRemoveSet.has(n.path));
        }
        let removedDirs = 0;
        for (const relDir of allDirs) {
            try {
                const absDir = path.resolve(vaultRoot, relDir);
                const entries = readdirSync(absDir);
                if (entries.length === 0) {
                    rmSync(absDir, { recursive: false });
                    removedDirs++;
                }
            }
            catch { }
        }
        this.rebuildBacklinkIndex();
        this.bumpRevisionAndInvalidate();
        return { removedFiles, removedDirs };
    }
    public applyTemplate(options: {
        template: string;
        variables?: Record<string, any>;
        filePath?: string;
        writeMode?: 'create' | 'overwrite' | 'append';
        heading?: string;
    }): {
        content: string;
        writtenPath?: string;
    } {
        const { template, variables = {}, filePath, writeMode = 'create', heading } = options;
        const rendered = template.replace(/{{\s*([a-zA-Z0-9_\.]+)\s*}}/g, (_m, key) => {
            if (key === 'date')
                return new Date().toISOString().slice(0, 10);
            if (key === 'datetime')
                return new Date().toISOString();
            const parts = String(key).split('.');
            let val: any = variables as any;
            for (const part of parts) {
                if (val && Object.prototype.hasOwnProperty.call(val, part))
                    val = val[part];
                else {
                    val = '';
                    break;
                }
            }
            return String(val ?? '');
        });
        if (filePath) {
            const res = this.writeNote({ filePath, content: rendered, writeMode, heading });
            return { content: rendered, writtenPath: res.relativePath };
        }
        return { content: rendered };
    }
    public bulkAutolink(options: {
        mappings: {
            term: string;
            toPath: string;
        }[];
        maxPerFile?: number;
        limitFiles?: number;
    }): {
        updatedFiles: number;
    } {
        const { mappings, maxPerFile = 3, limitFiles = 50 } = options;
        let updatedFiles = 0;
        const vaultRoot = path.resolve(this.vaultPath);
        const processed = new Set<string>();
        for (const n of this.indexData) {
            if (processed.size >= limitFiles)
                break;
            if (!n.path.endsWith('.md'))
                continue;
            if (n.path.startsWith('.obsidian/') || n.path.includes('/node_modules/'))
                continue;
            const abs = path.resolve(vaultRoot, n.path);
            if (!existsSync(abs))
                continue;
            let text = readFileSync(abs, 'utf-8');
            let hits = 0;
            for (const { term, toPath } of mappings) {
                const noteName = path.basename((toPath.toLowerCase().endsWith('.md') ? toPath : `${toPath}.md`), '.md');
                const re = new RegExp(`(?<!\\[\\[])(${this.escapeRegex(term)})`, 'gi');
                const before = text;
                text = text.replace(re, (m) => {
                    if (hits >= maxPerFile)
                        return m;
                    hits++;
                    return `[[${noteName}]]`;
                });
                if (text !== before && hits >= maxPerFile)
                    break;
            }
            if (hits > 0) {
                writeFileSync(abs, text, { encoding: 'utf-8' });
                try {
                    this.indexSingleFile(n.path);
                }
                catch { }
                updatedFiles++;
                processed.add(n.path);
            }
        }
        return { updatedFiles };
    }
    public moveNote(options: {
        fromPath: string;
        toPath: string;
        overwrite?: boolean;
    }): {
        from: string;
        to: string;
    } {
        const { fromPath, toPath, overwrite = false } = options;
        const vaultRoot = path.resolve(this.vaultPath);
        const fromRel = fromPath.toLowerCase().endsWith('.md') ? fromPath : `${fromPath}.md`;
        const toRel = toPath.toLowerCase().endsWith('.md') ? toPath : `${toPath}.md`;
        const fromAbs = path.resolve(vaultRoot, fromRel);
        const toAbs = path.resolve(vaultRoot, toRel);
        const toDir = path.dirname(toAbs);
        if (!existsSync(fromAbs))
            throw new Error(`Source not found: ${fromRel}`);
        if (existsSync(toAbs) && !overwrite)
            throw new Error(`Target exists: ${toRel}`);
        if (!existsSync(toDir))
            mkdirSync(toDir, { recursive: true });
        const data = readFileSync(fromAbs, 'utf-8');
        writeFileSync(toAbs, data, { encoding: 'utf-8' });
        rmSync(fromAbs);
        try {
            this.scheduleIndexSingleFile(toRel);
        }
        catch { }
        return { from: fromRel, to: toRel };
    }
    public cloneNote(options: {
        fromPath: string;
        toPath: string;
        setTitle?: string;
    }): {
        from: string;
        to: string;
    } {
        const { fromPath, toPath, setTitle } = options;
        const vaultRoot = path.resolve(this.vaultPath);
        const fromRel = fromPath.toLowerCase().endsWith('.md') ? fromPath : `${fromPath}.md`;
        const toRel = toPath.toLowerCase().endsWith('.md') ? toPath : `${toPath}.md`;
        const fromAbs = path.resolve(vaultRoot, fromRel);
        const toAbs = path.resolve(vaultRoot, toRel);
        const toDir = path.dirname(toAbs);
        if (!existsSync(fromAbs))
            throw new Error(`Source not found: ${fromRel}`);
        if (!existsSync(toDir))
            mkdirSync(toDir, { recursive: true });
        let data = readFileSync(fromAbs, 'utf-8');
        if (setTitle) {
            const parsed = this.parseFrontmatterAndBody(data);
            parsed.frontmatter.title = setTitle;
            data = this.buildMarkdownWithFrontmatter(parsed.frontmatter, parsed.body);
        }
        writeFileSync(toAbs, data, { encoding: 'utf-8' });
        try {
            this.scheduleIndexSingleFile(toRel);
        }
        catch { }
        return { from: fromRel, to: toRel };
    }
    public deleteNote(options: {
        path: string;
    }): {
        deletedPath: string;
    } {
        const { path: relInput } = options;
        const vaultRoot = path.resolve(this.vaultPath);
        const rel = relInput.toLowerCase().endsWith('.md') ? relInput : `${relInput}.md`;
        const abs = path.resolve(vaultRoot, rel.replace(/^\/+/, ''));
        if (!abs.startsWith(vaultRoot))
            throw new Error('Path escape detected');
        if (existsSync(abs)) {
            rmSync(abs);
        }
        return { deletedPath: rel };
    }
    private sanitizeName(name: string): string {
        return (name || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
    }
    public captureNote(options: {
        name: string;
        content: string;
        tags?: string[];
        relations?: string[];
        folder?: string;
        linkToHub?: boolean;
        hubs?: string[];
    }): {
        path: string;
    } {
        const { name, content, tags = [], relations = [], folder = 'inbox', linkToHub = true, hubs = [] } = options;
        if (!name || !content)
            throw new Error('name and content are required');
        const safeName = this.sanitizeName(name) || 'note';
        const relBase = `${folder.replace(/^\/+|\/+$/g, '')}/${safeName}.md`;
        const fmTags = Array.from(new Set([...(tags || []).map(t => String(t)), 'autocaptured']));
        const fm: Record<string, any> = { title: safeName, type: 'note', tags: fmTags };
        const relKey = this.graphPolicy.links?.defaultRelation || 'related';
        const disallow = (this.graphPolicy.global?.frontmatter?.disallow_keys || []);
        const canUseFmRelation = !disallow.includes(relKey);
        const relatedLinks: string[] = [];
        const addLink = (to: string) => {
            const rr = this.resolveNotePublic(to);
            const toPath = (rr && rr.exists && rr.path) ? rr.path : to;
            const wl = this.toWikiLink(toPath);
            if (!relatedLinks.includes(wl))
                relatedLinks.push(wl);
        };
        for (const r of relations)
            addLink(r);
        if (Array.isArray(hubs) && hubs.length > 0) {
            for (const h of hubs)
                addLink(h);
        }
        else if (linkToHub) {
            const hub = this.getCanonicalHubPath().replace(/\.md$/i, '');
            const wl = `[[${path.basename(hub, '.md')}]]`;
            if (!relatedLinks.includes(wl))
                relatedLinks.push(wl);
        }
        if (canUseFmRelation && relatedLinks.length)
            fm[relKey] = relatedLinks;
        const res = this.writeNote({ filePath: relBase, content, writeMode: 'create', frontmatter: fm, ensureMdExtension: true, createMissingFolders: true });
        if (Array.isArray(hubs) && hubs.length > 0) {
            for (const h of hubs) {
                const rr = this.resolveNotePublic(h);
                const toPath = (rr && rr.exists && rr.path) ? rr.path : h;
                this.appendRelationBody(res.relativePath, this.relationsHeading || 'Relations', this.toWikiLink(toPath));
            }
        }
        else if (linkToHub) {
            this.appendRelationBody(res.relativePath, this.relationsHeading || 'Relations', this.toWikiLink(this.getCanonicalHubPath()));
        }
        for (const r of relations) {
            const rr = this.resolveNotePublic(r);
            const toPath = (rr && rr.exists && rr.path) ? rr.path : r;
            this.appendRelationBody(res.relativePath, this.relationsHeading || 'Relations', this.toWikiLink(toPath));
        }
        return { path: res.relativePath };
    }
    public dailyJournalAppend(options: {
        content: string;
        heading?: string;
        bullet?: boolean;
        timestamp?: boolean;
        filePath?: string;
        date?: string;
    }): {
        path: string;
    } {
        const { content, heading = 'Inbox', bullet = true, timestamp = true, filePath, date } = options;
        if (!content)
            throw new Error('content is required');
        const day = (date && /\d{4}-\d{2}-\d{2}/.test(date)) ? date : new Date().toISOString().slice(0, 10);
        const rel = filePath ? filePath : `inbox/${day}.md`;
        this.writeNote({ filePath: rel, content, writeMode: 'append', heading, ensureMdExtension: true, createMissingFolders: true });
        return { path: rel.endsWith('.md') ? rel : `${rel}.md` };
    }
    public resolveNotePublic(input: string): {
        path?: string;
        id?: string;
        title?: string;
        aliases?: string[];
        exists: boolean;
        suggestions: string[];
    } {
        if (!input)
            return { exists: false, suggestions: [] } as any;
        const note = this.getNote(input);
        if (note) {
            return {
                path: note.path,
                id: note.id,
                title: note.title,
                aliases: note.aliases || [],
                exists: true,
                suggestions: []
            };
        }
        const p = this.resolveNoteKeyToPath(input);
        if (p) {
            const nn = this.indexData.find(n => n.path === p);
            return {
                path: p,
                id: nn?.id,
                title: nn?.title,
                aliases: nn?.aliases || [],
                exists: true,
                suggestions: []
            };
        }
        const key = this.normalizeNoteKey(input);
        const variants: string[] = [];
        for (const n of this.indexData) {
            const base = this.normalizeNoteKey(n.title || path.basename(n.path, '.md'));
            if (base.includes(key) || key.includes(base)) {
                variants.push(n.path);
                if (variants.length >= 10)
                    break;
            }
        }
        return { exists: false, suggestions: variants } as any;
    }
    private listFrontmatterLinks(note: ObsidianNote): Record<string, string[]> {
        const res: Record<string, string[]> = {};
        try {
            const { frontmatter } = this.parseFrontmatterAndBody(note.content || '');
            for (const [k, v] of Object.entries(frontmatter || {})) {
                const pushResolved = (val: string) => {
                    const m = val.match(/\[\[([^\]]+)\]\]/);
                    if (!m)
                        return;
                    const key = this.normalizeNoteKey(m[1].split('#')[0]);
                    const p = this.resolveNoteKeyToPath(key);
                    if (!p)
                        return;
                    if (!res[k])
                        res[k] = [];
                    if (!res[k].includes(p))
                        res[k].push(p);
                };
                if (Array.isArray(v)) {
                    for (const item of v)
                        if (typeof item === 'string')
                            pushResolved(item);
                }
                else if (typeof v === 'string') {
                    pushResolved(v);
                }
            }
        }
        catch { }
        return res;
    }
    public buildVaultTree(options: {
        root?: string;
        maxDepth?: number;
        includeFiles?: boolean;
        includeCounts?: boolean;
        sort?: 'name' | 'mtime' | 'count';
        limitPerDir?: number;
    }): any {
        const cacheKey = this.heavyKey('get-vault-tree', options);
        const cached = this.heavyGet(cacheKey);
        if (cached)
            return cached;
        const rootPrefix = (options.root || '').replace(/^\/+|\/+$/g, '');
        const maxDepth = Math.max(1, Math.min(10, options.maxDepth ?? 3));
        const includeFiles = options.includeFiles ?? false;
        const includeCounts = options.includeCounts ?? true;
        const sort = (options.sort || 'name') as 'name' | 'mtime' | 'count';
        const limitPerDir = options.limitPerDir ?? 50;
        type DirNode = {
            name: string;
            path: string;
            type: 'directory';
            children: (DirNode | any)[];
            counts: {
                files: number;
                md_files: number;
            };
            mtimeLatest?: string;
        };
        const root: DirNode = { name: rootPrefix || '/', path: rootPrefix || '/', type: 'directory', children: [], counts: { files: 0, md_files: 0 }, mtimeLatest: undefined };
        const dirMap = new Map<string, DirNode>();
        dirMap.set(rootPrefix || '/', root);
        const consider = (p: string) => rootPrefix ? p.startsWith(rootPrefix + '/') || p === rootPrefix : true;
        for (const n of this.indexData) {
            const p = n.path || '';
            if (!p.toLowerCase().endsWith('.md'))
                continue;
            if (!consider(p))
                continue;
            const parts = p.split('/');
            let acc = '';
            for (let i = 0; i < Math.min(parts.length - 1, maxDepth); i++) {
                acc = i === 0 ? parts[i] : acc + '/' + parts[i];
                const key = acc || '/';
                if (!dirMap.has(key)) {
                    const node: DirNode = { name: parts[i], path: key, type: 'directory', children: [], counts: { files: 0, md_files: 0 } };
                    dirMap.set(key, node);
                }
            }
        }
        for (const [key, node] of dirMap.entries()) {
            if (key === (rootPrefix || '/'))
                continue;
            const parent = key.includes('/') ? key.substring(0, key.lastIndexOf('/')) : (rootPrefix || '/');
            const parentNode = dirMap.get(parent) || root;
            if (!parentNode.children.includes(node))
                parentNode.children.push(node);
        }
        for (const n of this.indexData) {
            const p = n.path || '';
            if (!consider(p))
                continue;
            const md = p.toLowerCase().endsWith('.md');
            const dir = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : (rootPrefix || '/');
            const dirNode = dirMap.get(dir) || root;
            dirNode.counts.files++;
            if (md)
                dirNode.counts.md_files++;
            const lm = n.lastModified ? new Date(n.lastModified).toISOString() : undefined;
            if (lm) {
                if (!dirNode.mtimeLatest || lm > dirNode.mtimeLatest)
                    dirNode.mtimeLatest = lm;
            }
            if (includeFiles) {
                const file = { name: path.basename(p), path: p, type: 'file', mtime: n.lastModified || '', md: md };
                dirNode.children.push(file);
            }
        }
        const sorter = (a: any, b: any) => {
            if (a.type === 'file' && b.type === 'directory')
                return 1;
            if (a.type === 'directory' && b.type === 'file')
                return -1;
            if (sort === 'name')
                return a.name.localeCompare(b.name);
            if (sort === 'count')
                return (b.counts?.md_files || 0) - (a.counts?.md_files || 0);
            if (sort === 'mtime')
                return (b.mtimeLatest || b.mtime || '').localeCompare(a.mtimeLatest || a.mtime || '');
            return 0;
        };
        const walkSortLimit = (node: DirNode, depth: number) => {
            node.children.sort(sorter);
            if (limitPerDir && node.children.length > limitPerDir)
                node.children = node.children.slice(0, limitPerDir);
            if (depth >= maxDepth) {
                node.children = node.children.filter(c => c.type !== 'directory');
                return;
            }
            for (const c of node.children)
                if (c.type === 'directory')
                    walkSortLimit(c, depth + 1);
        };
        walkSortLimit(root, 0);
        if (!includeCounts) {
            const stripCounts = (node: DirNode) => {
                delete (node as any).counts;
                for (const c of node.children)
                    if (c.type === 'directory')
                        stripCounts(c);
            };
            stripCounts(root);
        }
        this.heavySet(cacheKey, root);
        return root;
    }
    public buildFolderContents(options: {
        folderPath: string;
        recursive?: boolean;
        sortBy?: 'name' | 'mtime' | 'degreeIn' | 'degreeOut';
        limit?: number;
        filter?: {
            ext?: string[];
            type?: string;
            tagIncludes?: string[];
        };
    }): any[] {
        const cacheKey = this.heavyKey('get-folder-contents', options);
        const cached = this.heavyGet(cacheKey);
        if (cached)
            return cached;
        const folder = options.folderPath.replace(/^\/+|\/+$/g, '');
        const recursive = options.recursive ?? false;
        const sortBy = (options.sortBy || 'mtime') as 'name' | 'mtime' | 'degreeIn' | 'degreeOut';
        const limit = options.limit ?? 200;
        const exts = options.filter?.ext;
        const typeFilter = options.filter?.type;
        const tagIncludes = options.filter?.tagIncludes || [];
        const isDirectChild = (p: string) => {
            if (!p.startsWith(folder + '/'))
                return false;
            const rest = p.substring(folder.length + 1);
            return !rest.includes('/');
        };
        const pick = (n: ObsidianNote) => {
            const p = n.path || '';
            if (folder && !(recursive ? p.startsWith(folder + '/') : isDirectChild(p)))
                return false;
            if (exts && exts.length > 0 && !exts.some(e => p.toLowerCase().endsWith(e.toLowerCase())))
                return false;
            if (typeFilter && String(n.type || '').toLowerCase() !== String(typeFilter).toLowerCase())
                return false;
            if (tagIncludes.length > 0) {
                const tags = (n.tags || []).map(t => String(t).toLowerCase());
                if (!tagIncludes.every(t => tags.includes(String(t).toLowerCase())))
                    return false;
            }
            return true;
        };
        const rows = this.indexData.filter(pick).map(n => {
            const degOut = this.getOutgoingPathsPub(n.path).length;
            const degIn = this.getBacklinkPathsPub(n.path).length;
            return {
                path: n.path,
                title: n.title || path.basename(n.path, '.md'),
                type: n.type || '',
                tags: n.tags || [],
                mtime: n.lastModified || '',
                degreeIn: degIn,
                degreeOut: degOut
            };
        });
        rows.sort((a, b) => {
            if (sortBy === 'name')
                return a.title.localeCompare(b.title);
            if (sortBy === 'mtime')
                return (b.mtime || '').localeCompare(a.mtime || '');
            if (sortBy === 'degreeIn')
                return b.degreeIn - a.degreeIn;
            if (sortBy === 'degreeOut')
                return b.degreeOut - a.degreeOut;
            return 0;
        });
        const out = rows.slice(0, limit);
        this.heavySet(cacheKey, out);
        return out;
    }
    private collectNoteEdges(note: ObsidianNote, includeBody: boolean, includeFM: boolean): {
        target: string;
        relation: string;
    }[] {
        const edges: {
            target: string;
            relation: string;
        }[] = [];
        if (includeBody) {
            const keys = this.extractWikiLinks(note.content || note.content_preview || '') || [];
            for (const key of keys) {
                const p = this.resolveNoteKeyToPath(key);
                if (p)
                    edges.push({ target: p, relation: 'wikilink' });
            }
        }
        if (includeFM) {
            const fm = this.listFrontmatterLinks(note);
            for (const [k, arr] of Object.entries(fm)) {
                for (const p of arr)
                    edges.push({ target: p, relation: `frontmatter:${k}` });
            }
        }
        return edges;
    }
    private buildEgoGraph(startPath: string, depth: number, direction: 'in' | 'out' | 'both', includeBody: boolean, includeFM: boolean, maxNodes: number, maxEdges: number) {
        const nodes = new Map<string, ObsidianNote>();
        const edges: {
            source: string;
            target: string;
            relation: string;
        }[] = [];
        const q: {
            path: string;
            d: number;
        }[] = [];
        const seen = new Set<string>();
        const pushNode = (p: string) => {
            if (nodes.size >= maxNodes)
                return false;
            const n = this.indexData.find(x => x.path === p);
            if (!n)
                return false;
            nodes.set(p, n);
            return true;
        };
        if (!pushNode(startPath))
            return { nodes, edges };
        q.push({ path: startPath, d: 0 });
        seen.add(startPath);
        while (q.length > 0) {
            const { path: p, d } = q.shift()!;
            if (d >= depth)
                continue;
            const addEdge = (src: string, dst: string, relation: string) => {
                if (edges.length >= maxEdges)
                    return;
                edges.push({ source: src, target: dst, relation });
            };
            if (direction === 'out' || direction === 'both') {
                const srcNote = this.indexData.find(x => x.path === p);
                if (srcNote) {
                    for (const e of this.collectNoteEdges(srcNote, includeBody, includeFM)) {
                        if (pushNode(e.target)) { }
                        addEdge(p, e.target, e.relation);
                        if (!seen.has(e.target)) {
                            seen.add(e.target);
                            q.push({ path: e.target, d: d + 1 });
                        }
                    }
                }
            }
            if (direction === 'in' || direction === 'both') {
                for (const n of this.indexData) {
                    if (nodes.size >= maxNodes)
                        break;
                    const outs = this.collectNoteEdges(n, includeBody, includeFM).filter(e => e.target === p);
                    if (outs.length > 0) {
                        if (pushNode(n.path)) { }
                        for (const e of outs)
                            addEdge(n.path, p, e.relation);
                        if (!seen.has(n.path)) {
                            seen.add(n.path);
                            q.push({ path: n.path, d: d + 1 });
                        }
                    }
                }
            }
            if (nodes.size >= maxNodes || edges.length >= maxEdges)
                break;
        }
        return { nodes, edges };
    }
    private buildFolderSubgraph(prefix: string, includeBody: boolean, includeFM: boolean, maxNodes: number, maxEdges: number) {
        const set = new Set<string>(this.indexData.filter(n => n.path.startsWith(prefix + '/') || n.path === prefix).map(n => n.path));
        const nodes = new Map<string, ObsidianNote>();
        for (const p of set) {
            if (nodes.size >= maxNodes)
                break;
            const n = this.indexData.find(x => x.path === p);
            if (n)
                nodes.set(p, n);
        }
        const edges: {
            source: string;
            target: string;
            relation: string;
        }[] = [];
        for (const n of nodes.values()) {
            for (const e of this.collectNoteEdges(n, includeBody, includeFM)) {
                if (edges.length >= maxEdges)
                    break;
                if (set.has(e.target))
                    edges.push({ source: n.path, target: e.target, relation: e.relation });
            }
            if (edges.length >= maxEdges)
                break;
        }
        return { nodes, edges };
    }
    private formatGraphMermaid(nodes: Map<string, ObsidianNote>, edges: {
        source: string;
        target: string;
        relation: string;
    }[]) {
        const ids = new Map<string, string>();
        let idx = 0;
        for (const p of nodes.keys())
            ids.set(p, `n${idx++}`);
        const esc = (s: string) => s.replace(/"/g, '\\"');
        const lines = ['graph TD'];
        for (const [p, n] of nodes.entries()) {
            lines.push(`  ${ids.get(p)}["${esc(n.title || path.basename(p, '.md'))}"]`);
        }
        for (const e of edges) {
            const a = ids.get(e.source), b = ids.get(e.target);
            if (a && b)
                lines.push(`  ${a} --> ${b}`);
        }
        return lines.join('\n');
    }
    private formatGraphDot(nodes: Map<string, ObsidianNote>, edges: {
        source: string;
        target: string;
        relation: string;
    }[]) {
        const esc = (s: string) => s.replace(/"/g, '\\"');
        const lines = ['digraph G {'];
        for (const n of nodes.values()) {
            lines.push(`  "${esc(n.path)}" [label="${esc(n.title || path.basename(n.path, '.md'))}"];`);
        }
        for (const e of edges)
            lines.push(`  "${esc(e.source)}" -> "${esc(e.target)}";`);
        lines.push('}');
        return lines.join('\n');
    }
    public getGraphSnapshot(args: {
        scope?: {
            startNoteId?: string;
            folderPrefix?: string;
        };
        depth?: number;
        direction?: 'in' | 'out' | 'both';
        include?: {
            bodyLinks?: boolean;
            fmLinks?: boolean;
        };
        maxNodes?: number;
        maxEdges?: number;
        annotate?: boolean;
        format?: 'json' | 'mermaid' | 'dot' | 'text';
        allowedRelations?: string[];
        nodeFilter?: {
            pathPrefix?: string;
            tagIncludes?: string[];
        };
    }) {
        const cacheKey = this.heavyKey('get-graph-snapshot', args);
        const cached = this.heavyGet(cacheKey);
        if (cached)
            return cached;
        const depth = Math.max(1, Math.min(3, args.depth ?? 2));
        const direction = (args.direction || 'both') as 'in' | 'out' | 'both';
        const includeBody = args.include?.bodyLinks ?? true;
        const includeFM = args.include?.fmLinks ?? true;
        const maxNodes = args.maxNodes ?? 300;
        const maxEdges = args.maxEdges ?? 1000;
        const annotate = args.annotate ?? true;
        const scope = args.scope || {};
        let nodes: Map<string, ObsidianNote>, edgeArr: {
            source: string;
            target: string;
            relation: string;
        }[];
        const allowSet = (args.allowedRelations && args.allowedRelations.length > 0) ? new Set(args.allowedRelations) : null;
        if (scope.startNoteId) {
            const resolved = this.resolveNotePublic(scope.startNoteId);
            if (!resolved.exists || !resolved.path)
                return { nodes: [], edges: [] };
            const res = this.buildEgoGraph(resolved.path, depth, direction, includeBody, includeFM, maxNodes, maxEdges);
            nodes = res.nodes;
            edgeArr = allowSet ? res.edges.filter(e => allowSet.has(e.relation)) : res.edges;
        }
        else if (scope.folderPrefix) {
            const res = this.buildFolderSubgraph(scope.folderPrefix.replace(/^\/+|\/+$/g, '').trim(), includeBody, includeFM, maxNodes, maxEdges);
            nodes = res.nodes;
            edgeArr = res.edges;
        }
        else {
            return { nodes: [], edges: [] };
        }
        const pairKey = (e: {
            source: string;
            target: string;
            relation: string;
        }) => `${e.source}__${e.target}`;
        const edgeAgg = new Map<string, Record<string, number>>();
        for (const e of edgeArr) {
            const k = pairKey(e);
            if (!edgeAgg.has(k))
                edgeAgg.set(k, {});
            const rels = edgeAgg.get(k)!;
            rels[e.relation] = (rels[e.relation] || 0) + 1;
        }
        let dedupEdges = Array.from(edgeAgg.keys()).map(k => {
            const [source, target] = k.split('__');
            return { source, target, relation: 'any' } as {
                source: string;
                target: string;
                relation: string;
            };
        });
        const nf = args.nodeFilter || {};
        if (nf.pathPrefix || (nf.tagIncludes && nf.tagIncludes.length)) {
            const keep = new Set<string>();
            const tagSet = (arr: string[] | undefined) => new Set((arr || []).map(t => String(t).toLowerCase()));
            const needTags = new Set((nf.tagIncludes || []).map(t => String(t).toLowerCase()));
            const hasAll = (ts: Set<string>) => Array.from(needTags).every(t => ts.has(t));
            for (const [p, n] of nodes.entries()) {
                const okPrefix = nf.pathPrefix ? p.startsWith(nf.pathPrefix) : true;
                const okTags = needTags.size ? hasAll(tagSet(n.tags)) : true;
                if (okPrefix && okTags)
                    keep.add(p);
            }
            const filteredNodes = new Map<string, ObsidianNote>();
            for (const p of keep) {
                const n = nodes.get(p);
                if (n)
                    filteredNodes.set(p, n);
            }
            const filteredEdges = dedupEdges.filter(e => keep.has(e.source) && keep.has(e.target));
            nodes = filteredNodes;
            dedupEdges = filteredEdges;
        }
        if (args.format === 'mermaid') {
            const text = this.formatGraphMermaid(nodes, dedupEdges);
            const truncated = (nodes.size >= maxNodes || edgeArr.length >= maxEdges);
            const withNote = truncated ? `${text}\n%% truncated (nodes=${nodes.size}, edges=${edgeArr.length})` : text;
            this.heavySet(cacheKey, withNote);
            return withNote;
        }
        if (args.format === 'dot') {
            const text = this.formatGraphDot(nodes, dedupEdges);
            const truncated = (nodes.size >= maxNodes || edgeArr.length >= maxEdges);
            const withNote = truncated ? `${text}\n// truncated (nodes=${nodes.size}, edges=${edgeArr.length})` : text;
            this.heavySet(cacheKey, withNote);
            return withNote;
        }
        const outNodes = Array.from(nodes.values()).map(n => ({
            id: n.id || n.path,
            path: n.path,
            title: n.title || path.basename(n.path, '.md'),
            type: n.type || '',
            folder: n.path.includes('/') ? n.path.substring(0, n.path.lastIndexOf('/')) : '',
            tags: n.tags || [],
            degIn: this.getBacklinkPathsPub(n.path).length,
            degOut: this.getOutgoingPathsPub(n.path).length
        }));
        const truncated = (nodes.size >= maxNodes || edgeArr.length >= maxEdges);
        const out = { nodes: outNodes, edges: dedupEdges, edgesAggregated: Array.from(edgeAgg.entries()).map(([k, v]) => ({ pair: k, relations: v })), truncated: truncated ? { nodesReturned: outNodes.length, edgesReturned: dedupEdges.length, maxNodes, maxEdges } : undefined };
        if (args.format === 'text') {
            const top = [...outNodes].sort((a, b) => (b.degIn + b.degOut) - (a.degIn + a.degOut)).slice(0, 10);
            const lines = [
                `Nodes: ${outNodes.length}, Edges: ${dedupEdges.length}`,
                truncated ? `NOTE: truncated (maxNodes=${maxNodes}, maxEdges=${maxEdges})` : undefined,
                `Top hubs:`,
                ...top.map(t => `- ${t.title} (${t.path}) deg=${t.degIn + t.degOut}`)
            ].filter(Boolean) as string[];
            const text = lines.join('\n');
            this.heavySet(cacheKey, text);
            return text;
        }
        this.heavySet(cacheKey, out);
        return out;
    }
    public getNoteNeighborhood(args: {
        noteId: string;
        depth?: number;
        fanoutLimit?: number;
        direction?: 'in' | 'out' | 'both';
        format?: 'text' | 'json';
    }) {
        const cacheKey = this.heavyKey('get-note-neighborhood', args);
        const cached = this.heavyGet(cacheKey);
        if (cached)
            return cached;
        const depth = Math.max(1, Math.min(3, args.depth ?? 2));
        const direction = (args.direction || 'both') as 'in' | 'out' | 'both';
        const fanout = args.fanoutLimit ?? 30;
        const resolved = this.resolveNotePublic(args.noteId);
        if (!resolved.exists || !resolved.path)
            return args.format === 'json' ? { levels: [] } : `Not found: ${args.noteId}`;
        const root = resolved.path;
        const levels: string[][] = [];
        let frontier = [root];
        const visited = new Set<string>([root]);
        for (let d = 0; d < depth; d++) {
            const next: string[] = [];
            const layer: string[] = [];
            for (const p of frontier) {
                let outs: string[] = [];
                let ins: string[] = [];
                if (direction === 'out' || direction === 'both')
                    outs = this.getOutgoingPathsPub(p).slice(0, fanout);
                if (direction === 'in' || direction === 'both')
                    ins = this.getBacklinkPathsPub(p).slice(0, fanout);
                for (const q of [...outs, ...ins])
                    if (!visited.has(q)) {
                        visited.add(q);
                        layer.push(q);
                        next.push(q);
                    }
            }
            levels.push(layer);
            frontier = next;
            if (levels.flat().length >= 300)
                break;
        }
        const truncated = levels.flat().length >= 300;
        if (args.format === 'json') {
            const out = { levels, truncated };
            this.heavySet(cacheKey, out);
            return out;
        }
        const lines: string[] = [`Root: ${root}`];
        levels.forEach((layer, i) => {
            lines.push(`L${i + 1}:`);
            for (const p of layer) {
                const n = this.indexData.find(x => x.path === p);
                lines.push(`- ${p} (${n?.title || ''})`);
            }
        });
        if (truncated)
            lines.push(`(truncated)`);
        const text = lines.join('\n');
        this.heavySet(cacheKey, text);
        return text;
    }
    public getRelationsOfNote(args: {
        noteId: string;
        include?: {
            bodyLinks?: boolean;
            frontmatterLists?: string[] | '*';
        };
    }) {
        const includeBody = args.include?.bodyLinks ?? true;
        const fmSel = args.include?.frontmatterLists;
        const resolved = this.resolveNotePublic(args.noteId);
        if (!resolved.exists || !resolved.path)
            return { wikilinks: [], frontmatter: {} };
        const n = this.indexData.find(x => x.path === resolved.path)!;
        const wikilinks: string[] = [];
        if (includeBody) {
            for (const key of this.extractWikiLinks(n.content || n.content_preview || '')) {
                const p = this.resolveNoteKeyToPath(key);
                if (p && !wikilinks.includes(p))
                    wikilinks.push(p);
            }
        }
        const fmAll = this.listFrontmatterLinks(n);
        const fm: Record<string, string[]> = {};
        if (fmSel === '*' || fmSel == null)
            Object.assign(fm, fmAll);
        else
            for (const k of fmSel)
                if (fmAll[k])
                    fm[k] = fmAll[k];
        return { wikilinks, frontmatter: fm };
    }
    public findPathBetween(args: {
        from: string;
        to: string;
        direction?: 'in' | 'out' | 'both';
        maxDepth?: number;
        allowedRelations?: string[];
        format?: 'text' | 'json' | 'mermaid';
    }) {
        const direction = (args.direction || 'both') as 'in' | 'out' | 'both';
        const maxDepth = Math.max(1, Math.min(6, args.maxDepth ?? 5));
        const allow = args.allowedRelations && args.allowedRelations.length > 0 ? new Set(args.allowedRelations) : null;
        const a = this.resolveNotePublic(args.from), b = this.resolveNotePublic(args.to);
        if (!a.exists || !a.path || !b.exists || !b.path)
            return args.format === 'json' ? { paths: [] } : `Not found: ${args.from} or ${args.to}`;
        if (a.path === b.path)
            return args.format === 'json' ? { paths: [[a.path]] } : `${a.path}`;
        const prev = new Map<string, {
            prev: string;
            relation: string;
        }>();
        const q: string[] = [a.path];
        const dist = new Map<string, number>();
        dist.set(a.path, 0);
        while (q.length > 0) {
            const cur = q.shift()!;
            const d = dist.get(cur)!;
            if (d >= maxDepth)
                continue;
            const expandFrom = (src: string) => {
                const note = this.indexData.find(x => x.path === src);
                if (!note)
                    return [] as {
                        target: string;
                        relation: string;
                    }[];
                return this.collectNoteEdges(note, true, true).filter(e => !allow || allow.has(e.relation));
            };
            if (direction === 'out' || direction === 'both') {
                for (const e of expandFrom(cur)) {
                    if (!dist.has(e.target)) {
                        dist.set(e.target, d + 1);
                        prev.set(e.target, { prev: cur, relation: e.relation });
                        q.push(e.target);
                    }
                    if (e.target === b.path) {
                        q.length = 0;
                        break;
                    }
                }
            }
            if (direction === 'in' || direction === 'both') {
                for (const n of this.indexData) {
                    for (const e of this.collectNoteEdges(n, true, true)) {
                        if (e.target !== cur)
                            continue;
                        const tgt = n.path;
                        if (allow && !allow.has(e.relation))
                            continue;
                        if (!dist.has(tgt)) {
                            dist.set(tgt, d + 1);
                            prev.set(tgt, { prev: cur, relation: e.relation });
                            q.push(tgt);
                        }
                        if (tgt === b.path) {
                            q.length = 0;
                            break;
                        }
                    }
                }
            }
        }
        if (!prev.has(b.path))
            return args.format === 'json' ? { paths: [] } : 'No path within maxDepth';
        const pathNodes: string[] = [];
        let cur = b.path;
        while (cur && cur !== a.path) {
            pathNodes.push(cur);
            cur = prev.get(cur)!.prev;
        }
        pathNodes.push(a.path);
        pathNodes.reverse();
        if (args.format === 'json')
            return { paths: [pathNodes] };
        if (args.format === 'mermaid') {
            const esc = (s: string) => s.replace(/"/g, '\\"');
            const lines = ['graph TD'];
            for (let i = 0; i < pathNodes.length; i++) {
                const p = pathNodes[i];
                const n = this.indexData.find(x => x.path === p);
                lines.push(`  n${i}["${esc(n?.title || path.basename(p, '.md'))}"]`);
                if (i > 0)
                    lines.push(`  n${i - 1} --> n${i}`);
            }
            return lines.join('\n');
        }
        return pathNodes.join(' -> ');
    }
    private embedTextHash(text: string): number[] {
        const dim = 32;
        const vec = new Array(dim).fill(0);
        const lc = (text || '').toLowerCase();
        for (let i = 0; i < lc.length; i++) {
            const code = lc.charCodeAt(i);
            if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57) || (code >= 1072 && code <= 1103)) {
                vec[code % dim] += 1;
            }
        }
        const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
        for (let i = 0; i < dim; i++)
            vec[i] = vec[i] / norm;
        return vec;
    }
    private ensureVector(notePath: string): number[] {
        const p = notePath.toLowerCase().endsWith('.md') ? notePath : `${notePath}.md`;
        const cached = this.embedStore.get(p);
        if (cached)
            return cached;
        const n = this.indexData.find(x => x.path === p);
        const text = n ? (n.content || n.content_preview || '') : '';
        const v = this.embedGenerate(text);
        this.embedStore.set(p, v);
        this.embedDirty = true;
        return v;
    }
    private scheduleEmbedUpdate(relPathInput: string): void {
        if (!this.embedPersist && !this.semanticEnabled)
            return;
        const rel = relPathInput.toLowerCase().endsWith('.md') ? relPathInput : `${relPathInput}.md`;
        this.embedPending.add(rel);
        if (this.embedUpdateTimer)
            return;
        this.embedUpdateTimer = setTimeout(() => {
            try {
                for (const p of Array.from(this.embedPending)) {
                    try {
                        this.ensureVector(p);
                    }
                    catch { }
                    this.embedPending.delete(p);
                }
                this.saveEmbedStoreToDiskDebounced();
            }
            finally {
                if (this.embedUpdateTimer) {
                    clearTimeout(this.embedUpdateTimer);
                    this.embedUpdateTimer = null;
                }
            }
        }, 700);
    }
    private loadEmbedStoreFromDisk(): void {
        if (!this.embedPersist)
            return;
        try {
            if (!existsSync(this.embedStorePath))
                return;
            const raw = JSON.parse(readFileSync(this.embedStorePath, 'utf-8')) as {
                vectors: Record<string, number[]>;
            };
            const map = raw?.vectors || {};
            let loaded = 0;
            for (const [k, v] of Object.entries(map)) {
                if (Array.isArray(v) && v.length > 0) {
                    this.embedStore.set(k, v);
                    loaded++;
                }
            }
            console.error(`💾 Semantic store loaded: ${loaded} vectors from ${this.embedStorePath}`);
        }
        catch (e) {
            console.error('⚠️ Failed to load semantic store:', e);
        }
    }
    private saveEmbedStoreToDiskDebounced(): void {
        if (!this.embedPersist)
            return;
        if (!this.embedDirty)
            return;
        if (this.embedSaveTimer)
            clearTimeout(this.embedSaveTimer);
        this.embedSaveTimer = setTimeout(() => {
            try {
                const dir = path.dirname(this.embedStorePath);
                try {
                    if (!existsSync(dir))
                        mkdirSync(dir, { recursive: true });
                }
                catch { }
                if (this.embedBackup && existsSync(this.embedStorePath)) {
                    try {
                        const bak = this.embedStorePath + '.bak';
                        const old = readFileSync(this.embedStorePath, 'utf-8');
                        writeFileSync(bak, old, { encoding: 'utf-8' });
                    }
                    catch { }
                }
                const obj: Record<string, number[]> = {};
                for (const [k, v] of this.embedStore.entries())
                    obj[k] = v;
                const payload = JSON.stringify({ vectors: obj }, null, 2);
                writeFileSync(this.embedStorePath, payload, { encoding: 'utf-8' });
                this.embedDirty = false;
                console.error(`💾 Semantic store saved (${this.embedStore.size} vectors)`);
            }
            catch (e) {
                console.error('⚠️ Failed to save semantic store:', e);
            }
            finally {
                this.embedSaveTimer = null;
            }
        }, 500);
    }
    private textRelevanceScore(n: ObsidianNote, query: string): number {
        const words = Array.from(new Set(this.extractQueryWords(query).filter(w => w && w.length >= 2)));
        if (words.length === 0)
            return 0;
        const lc = (s: string) => (s || '').toLowerCase();
        const content = lc(n.content || n.content_preview || '');
        const title = lc(n.title || '');
        const pth = lc(n.path || '');
        let cHits = 0, tHits = 0, pHits = 0;
        for (const w of words) {
            const ww = lc(w);
            if (content.includes(ww))
                cHits++;
            if (title.includes(ww))
                tHits++;
            if (pth.includes(ww))
                pHits++;
        }
        const cFrac = cHits / words.length;
        const tFrac = tHits / words.length;
        const pFrac = pHits / words.length;
        const few = words.length <= 2;
        const wC = few ? 0.45 : 0.6;
        const wT = few ? 0.35 : 0.25;
        const wP = few ? 0.20 : 0.15;
        let score = wC * cFrac + wT * tFrac + wP * pFrac;
        const phrase = lc(query).trim();
        if (phrase) {
            if (title.includes(phrase))
                score = Math.min(1, score + (few ? 0.20 : 0.12));
            if (content.includes(phrase))
                score = Math.min(1, score + (few ? 0.12 : 0.10));
        }
        return Math.max(0, Math.min(1, score));
    }
    private async initEmbedProviderAsync(): Promise<void> {
        try {
            const prov = (process.env.MCP_SEMANTIC_PROVIDER || 'hash').toLowerCase();
            this.embedProvider = (prov === 'xenova') ? 'xenova' : 'hash';
            this.embedModel = process.env.MCP_SEMANTIC_MODEL || 'Xenova/all-MiniLM-L6-v2';
            if (this.embedProvider === 'xenova') {
                const mod: any = await import('@xenova/transformers');
                const pipe = await mod.pipeline('feature-extraction', this.embedModel);
                this.embedXenovaPipeline = pipe;
                console.error(`🧪 Xenova provider initialized (${this.embedModel})`);
            }
        }
        catch (e) {
            this.embedProvider = 'hash';
            this.embedXenovaPipeline = null;
            console.error('⚠️ Xenova init failed, fallback to hash:', e?.toString?.() || e);
        }
    }
    private embedGenerate(text: string): number[] {
        if (this.embedProvider === 'xenova' && this.embedXenovaPipeline) {
            try { }
            catch { }
        }
        return this.embedTextHash(text);
    }
    public embedAndUpsert(args: {
        noteId: string;
        mode?: 'note' | 'chunks';
    }) {
        const r = this.resolveNotePublic(args.noteId);
        if (!r.exists || !r.path)
            return { ok: false, reason: 'not-found', semantic: this.semanticEnabled };
        const v = this.ensureVector(r.path);
        this.saveEmbedStoreToDiskDebounced();
        return { ok: true, path: r.path, dims: v.length, semantic: this.semanticEnabled };
    }
    public semanticQuery(args: {
        query: string;
        topK?: number;
        offset?: number;
        filters?: {
            pathPrefix?: string;
            tagIncludes?: string[];
            type?: string;
        };
    }) {
        const topK = Math.max(1, Math.min(50, args.topK ?? 5));
        const offset = Math.max(0, Math.min(10000, args.offset ?? 0));
        const query = String(args.query || '');
        const filters = args.filters || {};
        const cacheKey = this.heavyKey('semantic-query', { query, topK, offset, filters, alpha: this.SEM_ALPHA });
        const cached = this.heavyGet(cacheKey);
        if (cached)
            return cached;
        if (!this.semanticEnabled) {
            const results = this.searchNotes(query, topK, { mode: 'balanced', includeLinked: false });
            const out = results.map(r => ({ path: r.path, title: r.title.replace(/\*\*/g, ''), score: r.score, source: 'fallback' }));
            this.heavySet(cacheKey, out);
            return out;
        }
        const qv = this.embedGenerate(query);
        const consider = (n: ObsidianNote) => {
            if (filters.pathPrefix && !n.path.startsWith(filters.pathPrefix))
                return false;
            if (filters.tagIncludes && filters.tagIncludes.length > 0) {
                const tags = (n.tags || []).map(t => String(t).toLowerCase());
                for (const t of filters.tagIncludes)
                    if (!tags.includes(String(t).toLowerCase()))
                        return false;
            }
            if (filters.type) {
                const want = String(filters.type).toLowerCase();
                if (String(n.type || '').toLowerCase() !== want)
                    return false;
            }
            return true;
        };
        const scored: {
            path: string;
            title: string;
            score: number;
            snippet: string;
        }[] = [];
        let scanned = 0;
        const fewWords = this.extractQueryWords(query).filter(w => w && w.length >= 2).length <= 2;
        const localAlpha = fewWords ? Math.min(0.6, this.SEM_ALPHA) : this.SEM_ALPHA;
        const minLen = this.SEM_MINLEN_QUERY;
        const snipLen = fewWords ? Math.max(120, this.SNIPPET_LEN - 40) : this.SNIPPET_LEN;
        for (const n of this.indexData) {
            if (!consider(n))
                continue;
            const len = (n.content || n.content_preview || '').length;
            if (len < minLen)
                continue;
            scanned++;
            if (scanned > this.SEM_MAX_SCAN)
                break;
            const v = this.ensureVector(n.path);
            let dot = 0;
            for (let i = 0; i < Math.min(v.length, qv.length); i++)
                dot += v[i] * qv[i];
            const textRel = this.textRelevanceScore(n, query);
            const finalScore = localAlpha * dot + (1 - localAlpha) * textRel;
            const snippet = this.extractRelevantSnippet(n.content || '', query, snipLen);
            scored.push({ path: n.path, title: n.title || path.basename(n.path, '.md'), score: finalScore, snippet });
        }
        scored.sort((a, b) => b.score - a.score);
        const out = scored.slice(offset, offset + topK);
        this.heavySet(cacheKey, out);
        return out;
    }
    public semanticBuildIndex(args: {
        limit?: number;
    }) {
        const t0 = Date.now();
        let count = 0;
        let skipped = 0;
        let sumLen = 0;
        const byType: Record<string, number> = {};
        const limit = Math.max(0, args.limit ?? 0);
        const minLen = (() => { const v = parseInt(process.env.MCP_SEMANTIC_MINLEN || '80', 10); return Number.isFinite(v) && v >= 0 ? v : 80; })();
        for (const n of this.indexData) {
            const len = (n.content || n.content_preview || '').length;
            if (len < minLen) {
                skipped++;
                continue;
            }
            this.ensureVector(n.path);
            count++;
            sumLen += len;
            const tp = String(n.type || 'note').toLowerCase();
            byType[tp] = (byType[tp] || 0) + 1;
            if (limit && count >= limit)
                break;
        }
        const ms = Date.now() - t0;
        const avgLen = count ? Math.round(sumLen / count) : 0;
        this.saveEmbedStoreToDiskDebounced();
        return { ok: true, count, skipped, ms, avgLen, byType, minLenFilter: minLen, semantic: this.semanticEnabled };
    }
}
export function createServer() {
    console.error("🚀 Creating new ObsidianMCPServer instance");
    console.error("🎯 PRODUCTION SEARCH CONFIGURATION:");
    console.error(`   📊 Default limit: ${DEFAULT_LIMIT} results (increased by user request)`);
    console.error(`   🔍 Fuse.js threshold: 0.25 (balanced strictness)`);
    console.error(`   🎯 Quality threshold: 0.35 (good balance)`);
    console.error(`   🔗 Linked notes: max 1 per result, only for score < 0.2`);
    console.error(`   📝 Min match length: 3 characters`);
    console.error(`   📚 Categories: shown in descriptions, clean format`);
    if (!serverInstance) {
        serverInstance = new ObsidianMCPServer();
        serverInstance.loadIndexSync();
    }
    else {
        console.error("♻️  Reusing existing server instance");
    }
    const server = new Server({
        name: "obsidian-search",
        version: "2.0.0"
    }, {
        capabilities: {
            tools: {},
        }
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: "search",
                    description: `🔎 Search Obsidian notes (fuse|semantic|auto). Supports filters and output format.`,
                    inputSchema: {
                        type: "object",
                        properties: {
                            query: { type: "string", description: "Query string (advanced operators supported for fuse)" },
                            engine: { type: "string", enum: ["fuse", "semantic", "auto"], default: "auto" },
                            limit: { type: "number", default: 20 },
                            offset: { type: "number", default: 0 },
                            includeLinked: { type: "boolean", default: true },
                            filters: { type: "object", properties: { pathPrefix: { type: "string" }, tagIncludes: { type: "array", items: { type: "string" } }, type: { type: "string" } } },
                            format: { type: "string", enum: ["text", "json"], default: "text" }
                        },
                        required: ["query"]
                    }
                },
                {
                    name: "notes",
                    description: `📝 Unified note operations: write | append-under | journal | template | create-node | capture | frontmatter | link | unlink | move | clone | delete | autolink | find-unlinked-mentions`,
                    inputSchema: {
                        type: "object",
                        properties: {
                            operation: { type: "string", enum: ["write", "append-under", "journal", "template", "create-node", "capture", "frontmatter", "link", "unlink", "move", "clone", "delete", "autolink", "find-unlinked-mentions"], default: "write" },
                            filePath: { type: "string", description: "Note path" },
                            content: { type: "string", description: "Markdown content" },
                            writeMode: { type: "string", enum: ["create", "overwrite", "append"], default: "create" },
                            heading: { type: "string" },
                            frontmatter: { type: "object" },
                            ensureMdExtension: { type: "boolean", default: true },
                            createMissingFolders: { type: "boolean", default: true },
                            bullet: { type: "boolean", default: false },
                            timestamp: { type: "boolean", default: false },
                            date: { type: "string", description: "YYYY-MM-DD (journal)" },
                            template: { type: "string" },
                            variables: { type: "object" },
                            title: { type: "string" },
                            type: { type: "string" },
                            properties: { type: "object" },
                            name: { type: "string" },
                            tags: { type: "array", items: { type: "string" } },
                            relations: { type: "array", items: { type: "string" } },
                            folder: { type: "string", default: "inbox" },
                            linkToHub: { type: "boolean", default: true },
                            hubs: { type: "array", items: { type: "string" } },
                            fromPath: { type: "string" },
                            toPath: { type: "string" },
                            relation: { type: "string", default: "related" },
                            mode: { type: "string", enum: ["property", "body", "both"], default: "both" },
                            bidirectional: { type: "boolean", default: true },
                            overwrite: { type: "boolean" },
                            setTitle: { type: "string" },
                            path: { type: "string" },
                            mappings: { type: "array", items: { type: "object", properties: { term: { type: "string" }, toPath: { type: "string" } }, required: ["term", "toPath"] } },
                            maxPerFile: { type: "number", default: 3 },
                            limitFiles: { type: "number", default: 50 },
                            terms: { type: "array", items: { type: "string" } }
                        },
                        required: ["operation"]
                    }
                },
                {
                    name: "vault",
                    description: `🗂️ Vault: resolve | browse | content`,
                    inputSchema: {
                        type: "object",
                        properties: {
                            operation: { type: "string", enum: ["resolve", "browse", "content"], default: "resolve" },
                            input: { type: "string", description: "Title/alias/path (resolve)" },
                            mode: { type: "string", enum: ["tree", "list"], default: "tree" },
                            root: { type: "string" },
                            maxDepth: { type: "number", default: 3 },
                            includeFiles: { type: "boolean", default: false },
                            includeCounts: { type: "boolean", default: true },
                            sort: { type: "string", enum: ["name", "mtime", "count"], default: "name" },
                            limitPerDir: { type: "number", default: 50 },
                            folderPath: { type: "string" },
                            recursive: { type: "boolean", default: false },
                            sortBy: { type: "string", enum: ["name", "mtime", "degreeIn", "degreeOut"], default: "mtime" },
                            limit: { type: "number", default: 200 },
                            filter: { type: "object", properties: { ext: { type: "array", items: { type: "string" } }, type: { type: "string" }, tagIncludes: { type: "array", items: { type: "string" } } } },
                            format: { type: "string", enum: ["text", "json", "table"], default: "text" },
                            context7CompatibleLibraryID: { type: "string" },
                            tokens: { type: "number" },
                            topic: { type: "string" }
                        },
                        required: ["operation"]
                    }
                },
                {
                    name: "graph",
                    description: `🧭 Graph: query (relations|summary|neighborhood|snapshot|policy|path) and maintenance (repair|validate|reload-policy|normalize-baseline|find-uncategorized)`,
                    inputSchema: {
                        type: "object",
                        properties: {
                            action: { type: "string", enum: ["repair", "validate", "reload-policy", "normalize-baseline", "find-uncategorized"], description: "When provided, runs maintenance mode", default: "" },
                            pathPrefix: { type: "string" },
                            filePath: { type: "string" },
                            dryRun: { type: "boolean", default: false },
                            limit: { type: "number", default: 20 },
                            view: { type: "string", enum: ["relations", "summary", "neighborhood", "snapshot", "policy", "path", "auto"], description: "When provided, runs query mode" },
                            noteId: { type: "string" },
                            scope: { type: "object", properties: { startNoteId: { type: "string" }, folderPrefix: { type: "string" } } },
                            direction: { type: "string", enum: ["in", "out", "both"], default: "both" },
                            depth: { type: "number", default: 1 },
                            include: { type: "object", properties: { bodyLinks: { type: "boolean" }, fmLinks: { type: "boolean" }, frontmatterLists: { anyOf: [{ type: "array", items: { type: "string" } }, { const: "*" }] } } },
                            relation: { type: "string" },
                            allowedRelations: { type: "array", items: { type: "string" } },
                            nodeFilter: { type: "object", properties: { pathPrefix: { type: "string" }, tagIncludes: { type: "array", items: { type: "string" } } } },
                            fanoutLimit: { type: "number", default: 30 },
                            maxNodes: { type: "number", default: 300 },
                            maxEdges: { type: "number", default: 1000 },
                            annotate: { type: "boolean", default: true },
                            format: { type: "string", enum: ["text", "json", "mermaid", "dot"], default: "json" },
                            from: { type: "string" },
                            to: { type: "string" },
                            maxDepth: { type: "number", default: 5 }
                        },
                        required: []
                    }
                },
                {
                    name: "index",
                    description: `🛠️ Indexing and semantics: reindex-full | reindex-since | embed-one | embed-build`,
                    inputSchema: {
                        type: "object",
                        properties: {
                            action: { type: "string", enum: ["reindex-full", "reindex-since", "embed-one", "embed-build"], default: "reindex-full" },
                            since: { type: "string", description: "ISO time (for reindex-since)" },
                            noteId: { type: "string", description: "ID/path (for embed-one)" },
                            mode: { type: "string", enum: ["note", "chunks"], description: "Embedding mode (for embed-one)", default: "note" },
                            limit: { type: "number", description: "Limit (for embed-build)" }
                        },
                        required: ["action"]
                    }
                },
            ]
        };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (request.params.name === "search") {
            const args = request.params.arguments || {} as any;
            const engine = String(args.engine || 'auto');
            const format = String(args.format || 'text');
            const limit = Number(args.limit) || 20;
            const offset = Number(args.offset) || 0;
            const includeLinked = args.includeLinked !== false;
            let query = String(args.query || '');
            if (!query) {
                throw new Error("Missing required parameter: query");
            }
            if (engine !== 'semantic' && query.startsWith('preset:')) {
                const key = query.slice('preset:'.length);
                const preset = serverInstance!.getQueryPresets()[key];
                if (preset) {
                    console.error(`🎛️ Using preset "${key}": ${preset}`);
                    query = preset;
                }
                else {
                    console.error(`❌ Preset not found: ${key}`);
                }
            }
            let textOut = '';
            if (engine === 'semantic' || (engine === 'auto' && (serverInstance as any)?.semanticEnabled)) {
                const filters = args.filters || {};
                const sem = serverInstance!.semanticQuery({ query, topK: limit, offset, filters });
                if (format === 'json') {
                    return { content: [{ type: 'text', text: JSON.stringify(sem, null, 2) }] };
                }
                textOut = sem.map((r: any, i: number) => `${i + 1}. ${r.title} — ${r.path}  (score: ${r.score.toFixed(3)})\n${r.snippet}`).join('\n\n');
                return { content: [{ type: 'text', text: (textOut || `❌ No results`) }] };
            }
            const results = serverInstance!.searchNotes(query, limit, { mode: 'balanced', includeLinked });
            if (format === 'json') {
                return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
            }
            const formattedContent = results.length > 0 ?
                `📚 **Obsidian Notes Search Results**

Query: "${query}"
Total Results: ${results.length}

🌟 **Found ${results.length} relevant notes:**

${results.map((result, index) => {
                    const emoji = result.type === 'linked_note' ? '🔗' :
                        result.type === 'category_header' ? '📂' : '📄';
                    return `**${index + 1}. ${result.title}** (Score: ${result.score.toFixed(3)})
📁 Path: \`${result.path}\`
🕒 Modified: ${result.lastModified}
🔎 Type: ${result.type} (${result.confidence})
📄 Preview:
\`\`\`
${result.content_preview}
\`\`\`

---

`;
                }).join('')}` :
                `❌ **No results found** for query: "${query}"
        
Try:
- Different keywords or synonyms
- Broader search terms  
- Check spelling
- Use advanced operators like "exact phrase" or +required -excluded`;
            return {
                content: [
                    {
                        type: "text",
                        text: formattedContent
                    }
                ]
            };
        }
        if (request.params.name === "get-note-content") {
            let noteId = request.params.arguments?.context7CompatibleLibraryID as string;
            const maxTokens = request.params.arguments?.tokens as number;
            let topic = request.params.arguments?.topic as string;
            if (!noteId) {
                throw new Error("Missing required parameter: context7CompatibleLibraryID");
            }
            let headingFromId: string | undefined;
            if (noteId.includes('#')) {
                const [base, head] = noteId.split('#');
                noteId = base;
                if (!topic && head)
                    headingFromId = head;
            }
            const resolved = serverInstance!.resolveNotePublic(noteId);
            const resolvedId = (resolved && resolved.exists && resolved.path) ? resolved.path : noteId;
            const fullContent = serverInstance!.getFullNoteContent(resolvedId);
            if (!fullContent) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `❌ **Note not found**: "${noteId}"
              
Please check:
- Note ID is correct
- File path exists
- Note is indexed in the system`
                        }
                    ]
                };
            }
            let content = fullContent;
            const tryExtractByHeading = (text: string, heading: string): string | null => {
                try {
                    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const lines = text.split('\n');
                    const rx = new RegExp(`^#{1,6}\\s+${esc(heading)}\\s*$`, 'i');
                    let start = -1, level = 0;
                    for (let i = 0; i < lines.length; i++) {
                        const m = lines[i].match(/^(#+)\s+(.*)$/);
                        if (!m)
                            continue;
                        const hl = m[1].length;
                        const title = m[2].trim();
                        if (rx.test(lines[i]) || title.toLowerCase() === heading.toLowerCase()) {
                            start = i;
                            level = hl;
                            break;
                        }
                    }
                    if (start === -1)
                        return null;
                    let end = lines.length;
                    for (let j = start + 1; j < lines.length; j++) {
                        const mm = lines[j].match(/^(#+)\s+/);
                        if (mm) {
                            const l = mm[1].length;
                            if (l <= level) {
                                end = j;
                                break;
                            }
                        }
                    }
                    return lines.slice(start, end).join('\n');
                }
                catch {
                    return null;
                }
            };
            const targetHeading = headingFromId || topic;
            if (targetHeading) {
                const section = tryExtractByHeading(fullContent, targetHeading);
                if (section) {
                    content = section + '\n\n📄 **Full content below:**\n\n' + fullContent;
                }
                else {
                    const notFoundMsg = `🔎 Heading not found: "${targetHeading}"`;
                    if (topic) {
                        const lines = fullContent.split('\n');
                        const topicLower = topic.toLowerCase();
                        const relevantSections: string[] = [];
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i];
                            if (line.toLowerCase().includes(topicLower)) {
                                const start = Math.max(0, i - 3);
                                const end = Math.min(lines.length, i + 6);
                                const section = lines.slice(start, end).join('\n');
                                relevantSections.push(section);
                            }
                        }
                        if (relevantSections.length > 0) {
                            content = notFoundMsg + '\n\n' + `📍 **Sections related to \"${topic}\":**\n\n` + relevantSections.join('\n\n---\n\n') + '\n\n📄 **Full content below:**\n\n' + fullContent;
                        }
                        else {
                            content = notFoundMsg + '\n\n' + fullContent;
                        }
                    }
                    else {
                        content = notFoundMsg + '\n\n' + fullContent;
                    }
                }
            }
            if (!headingFromId && topic) {
                const lines = fullContent.split('\n');
                const topicLower = topic.toLowerCase();
                const matched = lines.some(l => l.toLowerCase().includes(topicLower));
                if (!matched) {
                    content = `🔎 Topic not found: "${topic}"` + '\n\n' + fullContent;
                }
            }
            if (maxTokens && maxTokens > 0) {
                const approximateTokens = content.length / 4;
                if (approximateTokens > maxTokens) {
                    content = content.substring(0, maxTokens * 4) + '\n\n... (content truncated by token limit)';
                }
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `📄 **FULL CONTENT** of note: "${noteId}"

${content}`
                    }
                ]
            };
        }
        if (request.params.name === "notes") {
            const args = request.params.arguments || {} as any;
            const op = String(args.operation || 'write');
            if (op === 'write') {
                const filePath = String(args.filePath || '');
                const content = String(args.content || '');
                if (!filePath || !content)
                    throw new Error('filePath and content are required for operation=write');
                const res = serverInstance!.writeNote({
                    filePath,
                    content,
                    writeMode: (args.writeMode as 'create' | 'overwrite' | 'append') || 'create',
                    heading: args.heading,
                    frontmatter: args.frontmatter,
                    ensureMdExtension: (args.ensureMdExtension as boolean) ?? true,
                    createMissingFolders: (args.createMissingFolders as boolean) ?? true
                });
                return { content: [{ type: 'text', text: `✅ Note written: ${res.relativePath} (mode=${args.writeMode || 'create'}, bytes=${res.bytesWritten})` }] };
            }
            if (op === 'append-under') {
                const filePath = String(args.filePath || '');
                const heading = String(args.heading || '');
                const raw = String(args.content || '');
                if (!filePath || !heading || !raw)
                    throw new Error('filePath, heading and content are required for operation=append-under');
                const content = `${(args.bullet === true) ? '- ' : ''}${(args.timestamp === true) ? (new Date().toISOString() + ' ') : ''}${raw}`;
                const res = serverInstance!.writeNote({
                    filePath,
                    content,
                    writeMode: 'append',
                    heading,
                    ensureMdExtension: (args.ensureMdExtension as boolean) ?? true,
                    createMissingFolders: (args.createMissingFolders as boolean) ?? true
                });
                return { content: [{ type: 'text', text: `✅ Appended under "${heading}": ${res.relativePath} (bytes=${res.bytesWritten})` }] };
            }
            if (op === 'journal') {
                const content = String(args.content || '');
                if (!content)
                    throw new Error('content is required for operation=journal');
                const res = serverInstance!.dailyJournalAppend({
                    content,
                    heading: args.heading || 'Inbox',
                    bullet: (args.bullet as boolean) ?? true,
                    timestamp: (args.timestamp as boolean) ?? true,
                    filePath: args.filePath,
                    date: args.date
                });
                return { content: [{ type: 'text', text: `🗒️ Journal appended: ${res.path}` }] };
            }
            if (op === 'template') {
                const template = String(args.template || '');
                if (!template)
                    throw new Error('template is required for operation=template');
                const r = serverInstance!.applyTemplate({ template, variables: args.variables, filePath: args.filePath, writeMode: args.writeMode, heading: args.heading });
                const info = r.writtenPath ? `\nWritten to: ${r.writtenPath}` : '';
                return { content: [{ type: 'text', text: `✅ Template applied${info}\n\n${r.content}` }] };
            }
            if (op === 'create-node') {
                const filePath = String(args.filePath || '');
                if (!filePath)
                    throw new Error('filePath is required for operation=create-node');
                const res = serverInstance!.createNode({
                    filePath,
                    title: args.title,
                    type: args.type,
                    properties: args.properties,
                    content: args.content,
                    ensureMdExtension: (args.ensureMdExtension as boolean) ?? true,
                    createMissingFolders: (args.createMissingFolders as boolean) ?? true
                });
                return { content: [{ type: 'text', text: `✅ Node created: ${res.relativePath}` }] };
            }
            if (op === 'capture') {
                const res = serverInstance!.captureNote({
                    name: String(args.name || ''),
                    content: String(args.content || ''),
                    tags: Array.isArray(args.tags) ? args.tags : undefined,
                    relations: Array.isArray(args.relations) ? args.relations : undefined,
                    folder: args.folder,
                    linkToHub: (args.linkToHub as boolean) ?? true,
                    hubs: Array.isArray(args.hubs) ? args.hubs : undefined,
                });
                return { content: [{ type: 'text', text: `✅ Captured: ${res.path}` }] };
            }
            if (op === 'frontmatter') {
                const res = serverInstance!.upsertFrontmatter({
                    filePath: String(args.filePath || ''),
                    set: args.set,
                    removeKeys: args.removeKeys,
                    ensureMdExtension: (args.ensureMdExtension as boolean) ?? true,
                    createMissingFolders: (args.createMissingFolders as boolean) ?? true
                });
                return { content: [{ type: 'text', text: `✅ Frontmatter updated: ${res.relativePath}` }] };
            }
            if (op === 'link' || op === 'unlink') {
                const params = {
                    fromPath: String(args.fromPath || ''),
                    toPath: String(args.toPath || ''),
                    relation: args.relation || 'related',
                    mode: (args.mode as 'property' | 'body' | 'both') || 'both',
                    bidirectional: (args.bidirectional as boolean) ?? true,
                    heading: args.heading || 'Relations'
                };
                const res = op === 'link' ? serverInstance!.linkNotes(params) : serverInstance!.unlinkNotes(params as any);
                const verb = op === 'link' ? 'Linked' : 'Unlinked';
                const arrow = op === 'link' ? '⇄' : '↮';
                return { content: [{ type: 'text', text: `✅ ${verb}: ${params.fromPath} ${arrow} ${params.toPath} (${params.mode}/${params.relation})` }] };
            }
            if (op === 'move') {
                const res = serverInstance!.moveNote({ fromPath: String(args.fromPath || ''), toPath: String(args.toPath || ''), overwrite: (args.overwrite as boolean) ?? false });
                return { content: [{ type: 'text', text: `📦 Moved: ${res.from} → ${res.to}` }] };
            }
            if (op === 'clone') {
                const res = serverInstance!.cloneNote({ fromPath: String(args.fromPath || ''), toPath: String(args.toPath || ''), setTitle: args.setTitle });
                return { content: [{ type: 'text', text: `📄 Cloned: ${res.from} → ${res.to}` }] };
            }
            if (op === 'delete') {
                const res = serverInstance!.deleteNote({ path: String(args.path || '') });
                return { content: [{ type: 'text', text: `🗑️ Deleted: ${res.deletedPath}` }] };
            }
            if (op === 'autolink') {
                const res = serverInstance!.bulkAutolink({ mappings: args.mappings || [], maxPerFile: args.maxPerFile, limitFiles: args.limitFiles });
                return { content: [{ type: 'text', text: `🔗 Bulk autolink updated files: ${res.updatedFiles}` }] };
            }
            if (op === 'find-unlinked-mentions') {
                const terms: string[] = (args.terms as string[]) || [];
                const maxPerFile = (args.maxPerFile as number) ?? 3;
                const limitFiles = (args.limitFiles as number) ?? 30;
                const patterns = terms.map(t => ({ term: t, re: new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') }));
                const suggestions: string[] = [];
                let filesCount = 0;
                for (const n of serverInstance!.getIndexData()) {
                    if (n.path.startsWith('.obsidian/') || n.path.includes('/node_modules/'))
                        continue;
                    if (filesCount >= limitFiles)
                        break;
                    const text = (n.content || n.content_preview || '');
                    let hits = 0;
                    for (const { term, re } of patterns) {
                        let m: RegExpExecArray | null;
                        while ((m = re.exec(text)) !== null) {
                            const idx = m.index;
                            const before = text.slice(Math.max(0, idx - 2), idx);
                            if (before === '[[')
                                continue;
                            const start = Math.max(0, idx - 40);
                            const end = Math.min(text.length, idx + term.length + 40);
                            const snippet = text.slice(start, end).replace(/\n/g, ' ');
                            suggestions.push(`- ${n.path}: …${snippet}…`);
                            hits++;
                            if (hits >= maxPerFile)
                                break;
                        }
                        if (hits >= maxPerFile)
                            break;
                    }
                    if (hits > 0)
                        filesCount++;
                }
                const outText = suggestions.length ? suggestions.join('\n') : 'No unlinked mentions found';
                return { content: [{ type: 'text', text: outText }] };
            }
            throw new Error(`Unknown operation: ${op}`);
        }
        if (request.params.name === "index") {
            const args = request.params.arguments || {} as any;
            const action = String(args.action || 'reindex-full');
            if (action === 'reindex-full') {
                const res = await serverInstance!.reindexVault();
                return { content: [{ type: 'text', text: `🔄 Reindexed notes: ${res.notes}` }] };
            }
            if (action === 'reindex-since') {
                const sinceIso = String(args.since || '');
                const since = new Date(sinceIso).getTime();
                if (Number.isNaN(since))
                    throw new Error('Invalid ISO date');
                const vaultRoot = path.resolve(serverInstance!.getVaultRoot());
                let changed = 0;
                const walk = (dir: string) => {
                    const entries = readdirSync(dir);
                    for (const entry of entries) {
                        const full = path.join(dir, entry);
                        const st = statSync(full);
                        if (st.isDirectory())
                            walk(full);
                        else if (st.isFile() && entry.toLowerCase().endsWith('.md')) {
                            if (st.mtimeMs >= since) {
                                const rel = path.relative(vaultRoot, full).replace(/\\/g, '/');
                                serverInstance!.reindexFileIncremental(rel);
                                changed++;
                            }
                        }
                    }
                };
                walk(vaultRoot);
                return { content: [{ type: 'text', text: `Delta reindexed: ${changed}` }] };
            }
            if (action === 'embed-one') {
                const noteId = String(args.noteId || '');
                if (!noteId)
                    throw new Error('noteId is required for embed-one');
                const res = serverInstance!.embedAndUpsert({ noteId, mode: args.mode });
                return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
            }
            if (action === 'embed-build') {
                const res = serverInstance!.semanticBuildIndex({ limit: args.limit });
                return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
            }
            throw new Error(`Unknown index action: ${action}`);
        }
        if (false && request.params.name === "note-ops") {
            const args = request.params.arguments || {} as any;
            const op = String(args.operation || 'capture');
            if (op === 'capture') {
                const res = serverInstance!.captureNote({
                    name: String(args.name || ''),
                    content: String(args.content || ''),
                    tags: Array.isArray(args.tags) ? args.tags : undefined,
                    relations: Array.isArray(args.relations) ? args.relations : undefined,
                    folder: args.folder,
                    linkToHub: (args.linkToHub as boolean) ?? true,
                    hubs: Array.isArray(args.hubs) ? args.hubs : undefined,
                });
                return { content: [{ type: 'text', text: `✅ Captured: ${res.path}` }] };
            }
            if (op === 'frontmatter') {
                const res = serverInstance!.upsertFrontmatter({
                    filePath: String(args.filePath || ''),
                    set: args.set,
                    removeKeys: args.removeKeys,
                    ensureMdExtension: (args.ensureMdExtension as boolean) ?? true,
                    createMissingFolders: (args.createMissingFolders as boolean) ?? true
                });
                return { content: [{ type: 'text', text: `✅ Frontmatter updated: ${res.relativePath}` }] };
            }
            if (op === 'link' || op === 'unlink') {
                const params = {
                    fromPath: String(args.fromPath || ''),
                    toPath: String(args.toPath || ''),
                    relation: args.relation || 'related',
                    mode: (args.mode as 'property' | 'body' | 'both') || 'both',
                    bidirectional: (args.bidirectional as boolean) ?? true,
                    heading: args.heading || 'Relations'
                };
                const res = op === 'link' ? serverInstance!.linkNotes(params) : serverInstance!.unlinkNotes(params as any);
                const verb = op === 'link' ? 'Linked' : 'Unlinked';
                const arrow = op === 'link' ? '⇄' : '↮';
                return { content: [{ type: 'text', text: `✅ ${verb}: ${params.fromPath} ${arrow} ${params.toPath} (${params.mode}/${params.relation})` }] };
            }
            if (op === 'move') {
                const res = serverInstance!.moveNote({ fromPath: String(args.fromPath || ''), toPath: String(args.toPath || ''), overwrite: (args.overwrite as boolean) ?? false });
                return { content: [{ type: 'text', text: `📦 Moved: ${res.from} → ${res.to}` }] };
            }
            if (op === 'clone') {
                const res = serverInstance!.cloneNote({ fromPath: String(args.fromPath || ''), toPath: String(args.toPath || ''), setTitle: args.setTitle });
                return { content: [{ type: 'text', text: `📄 Cloned: ${res.from} → ${res.to}` }] };
            }
            if (op === 'delete') {
                const res = serverInstance!.deleteNote({ path: String(args.path || '') });
                return { content: [{ type: 'text', text: `🗑️ Deleted: ${res.deletedPath}` }] };
            }
            if (op === 'autolink') {
                const res = serverInstance!.bulkAutolink({ mappings: args.mappings || [], maxPerFile: args.maxPerFile, limitFiles: args.limitFiles });
                return { content: [{ type: 'text', text: `🔗 Bulk autolink updated files: ${res.updatedFiles}` }] };
            }
            throw new Error(`Unknown note-ops operation: ${op}`);
        }
        if (false && request.params.name === "find-unlinked-mentions") {
            const args = request.params.arguments || {} as any;
            const terms: string[] = (args.terms as string[]) || [];
            const maxPerFile = (args.maxPerFile as number) ?? 3;
            const limitFiles = (args.limitFiles as number) ?? 30;
            const patterns = terms.map(t => ({ term: t, re: new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') }));
            const suggestions: string[] = [];
            let filesCount = 0;
            for (const n of serverInstance!.getIndexData()) {
                if (n.path.startsWith('.obsidian/') || n.path.includes('/node_modules/'))
                    continue;
                if (filesCount >= limitFiles)
                    break;
                const text = (n.content || n.content_preview || '');
                let hits = 0;
                for (const { term, re } of patterns) {
                    for (const mm of text.matchAll(re)) {
                        const idx = mm.index ?? 0;
                        const before = text.slice(Math.max(0, idx - 2), idx);
                        if (before === '[[')
                            continue;
                        const start = Math.max(0, idx - 40);
                        const end = Math.min(text.length, idx + term.length + 40);
                        const snippet = text.slice(start, end).replace(/\n/g, ' ');
                        suggestions.push(`- ${n.path}: …${snippet}…`);
                        hits++;
                        if (hits >= maxPerFile)
                            break;
                    }
                    if (hits >= maxPerFile)
                        break;
                }
                if (hits > 0)
                    filesCount++;
            }
            const outText = suggestions.length ? suggestions.join('\n') : 'No unlinked mentions found';
            return { content: [{ type: 'text', text: outText }] };
        }
        if (request.params.name === "graph") {
            const args = request.params.arguments || {} as any;
            const action = String(args.action || 'validate');
            if (action === 'repair') {
                const res = serverInstance!.repairGraph();
                return { content: [{ type: 'text', text: `🧹 Graph repaired: ${res.fixed} relations ensured/cleaned` }] };
            }
            if (action === 'purge-subtree') {
                const pathPrefix = String(args.pathPrefix || args.prefix || '');
                const dryRun = (args.dryRun as boolean) ?? false;
                const deleteNonMd = (args.deleteNonMd as boolean) ?? false;
                if (!pathPrefix)
                    throw new Error('pathPrefix is required for purge-subtree');
                const res = serverInstance!.purgeSubtree({ pathPrefix, dryRun, deleteNonMd });
                const summary = dryRun
                    ? `🔎 Dry run: would remove ${res.listedFiles?.length || 0} files and ${res.listedDirs?.length || 0} dirs under ${pathPrefix}`
                    : `🧹 Purged ${res.removedFiles} files and ${res.removedDirs} directories under ${pathPrefix}`;
                return { content: [{ type: 'text', text: summary }] };
            }
            if (action === 'reload-policy') {
                serverInstance!.loadGraphPolicy();
                const p = serverInstance!.getGraphPolicyPublic();
                return { content: [{ type: 'text', text: `🔁 Graph policy reloaded (mode=${p.mode})` }] };
            }
            if (action === 'validate') {
                const prefix = (args.pathPrefix as string) || '';
                const items = serverInstance!.getIndexData().filter((n: ObsidianNote) => n.path.endsWith('.md') && (!prefix || n.path.startsWith(prefix)));
                const results = [] as Array<{
                    path: string;
                    issues: string[];
                }>;
                for (const n of items) {
                    const content = n.content || n.content_preview || '';
                    const parsed = serverInstance!.parseFrontmatterPublic(content);
                    const issues = serverInstance!.validateAgainstPolicyPublic(n.path, parsed.frontmatter || {});
                    if (issues.length)
                        results.push({ path: n.path, issues });
                }
                const summary = { total: items.length, invalid: results.length };
                return { content: [{ type: 'text', text: JSON.stringify({ summary, results }, null, 2) }] };
            }
            if (action === 'normalize-baseline') {
                const filePath = String(args.filePath || '');
                const dryRun = (args.dryRun as boolean) ?? false;
                const forceParent = (args.forceParent as boolean) ?? false;
                if (!filePath)
                    throw new Error('filePath is required for normalize-baseline');
                const res = serverInstance!.normalizeNoteBaseline({ filePath, dryRun, forceParent });
                return { content: [{ type: 'text', text: `🧰 Normalized: \`${res.path}\`\nUpdated keys: ${res.updatedKeys.join(', ') || 'none'}\nGuess: ${JSON.stringify(res.guessed, null, 2)}` }] };
            }
            if (action === 'find-uncategorized') {
                const limit = Number(args.limit) || 20;
                const items = serverInstance!.findUncategorizedNotes({ limit });
                const formatted = items.map((i, idx) => `${idx + 1}. ${i.title} — \`${i.path}\` \n   reasons: ${i.reasons.join(', ')}`).join('\n');
                return { content: [{ type: 'text', text: (items.length ? `🧹 Found ${items.length} uncategorized notes:\n\n${formatted}` : '✅ No uncategorized notes found.') }] };
            }
            throw new Error(`Unknown graph-maintenance action: ${action}`);
        }
        if (false && request.params.name === "graph-query") {
            const args = request.params.arguments || {} as any;
            const view = String(args.view || 'summary');
            if (view === 'policy') {
                const p = serverInstance!.getGraphPolicyPublic();
                return { content: [{ type: 'text', text: JSON.stringify(p, null, 2) }] };
            }
            if (view === 'relations') {
                const noteId = String(args.noteId || '');
                if (!noteId)
                    throw new Error('noteId is required for view=relations');
                const res = serverInstance!.getRelationsOfNote({ noteId, include: args.include });
                return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
            }
            if (view === 'neighborhood') {
                const noteId = String(args.noteId || '');
                if (!noteId)
                    throw new Error('noteId is required for view=neighborhood');
                const res = serverInstance!.getNoteNeighborhood({
                    noteId,
                    depth: args.depth,
                    fanoutLimit: args.fanoutLimit,
                    direction: args.direction,
                    format: args.format || 'json'
                });
                const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
                return { content: [{ type: 'text', text }] };
            }
            if (view === 'path') {
                const from = String(args.from || '');
                const to = String(args.to || '');
                if (!from || !to)
                    throw new Error('from and to are required for view=path');
                const res = serverInstance!.findPathBetween({ from, to, direction: args.direction, maxDepth: args.maxDepth, allowedRelations: args.allowedRelations, format: args.format });
                const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
                return { content: [{ type: 'text', text }] };
            }
            if (view === 'snapshot') {
                const res = serverInstance!.getGraphSnapshot({
                    scope: args.scope,
                    depth: args.depth,
                    direction: args.direction,
                    include: args.include,
                    maxNodes: args.maxNodes,
                    maxEdges: args.maxEdges,
                    annotate: args.annotate,
                    format: args.format,
                    allowedRelations: args.allowedRelations,
                    nodeFilter: args.nodeFilter
                });
                const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
                return { content: [{ type: 'text', text }] };
            }
            {
                const noteId = String(args.noteId || '');
                if (!noteId)
                    throw new Error('noteId is required for view=summary');
                const depth = Math.max(1, Math.min(3, (args.depth as number) || 1));
                const direction = (args.direction as 'in' | 'out' | 'both') || 'both';
                const startPath = serverInstance!.getNotePathFromId(noteId);
                if (!startPath)
                    throw new Error(`Note not found: ${noteId}`);
                const startPathStr: string = String(startPath);
                const visited = new Set<string>();
                const layers: string[][] = [];
                let current: string[] = [startPathStr];
                visited.add(startPathStr);
                for (let d = 0; d < depth; d++) {
                    const next: string[] = [];
                    const layer: string[] = [];
                    for (const p of current) {
                        let outs: string[] = [];
                        let ins: string[] = [];
                        if (direction === 'out' || direction === 'both')
                            outs = serverInstance!.getOutgoingPathsPub(p);
                        if (direction === 'in' || direction === 'both')
                            ins = serverInstance!.getBacklinkPathsPub(p);
                        for (const q of [...outs, ...ins]) {
                            if (!visited.has(q)) {
                                visited.add(q);
                                layer.push(q);
                                next.push(q);
                            }
                        }
                    }
                    if (layer.length > 0)
                        layers.push(layer);
                    current = next;
                }
                if ((args.format || 'text') === 'json') {
                    const nodes = layers.flat().map(p => {
                        const n = serverInstance!.getIndexData().find(x => x.path === p);
                        return { path: p, title: n?.title || '', degIn: serverInstance!.getBacklinkPathsPub(p).length, degOut: serverInstance!.getOutgoingPathsPub(p).length };
                    });
                    return { content: [{ type: 'text', text: JSON.stringify({ root: startPathStr, depth, direction, nodesByLayer: layers, nodes }, null, 2) }] };
                }
                const lines: string[] = [];
                lines.push(`Root: ${startPath}`);
                layers.forEach((layer, i) => {
                    lines.push(`Depth ${i + 1}:`);
                    for (const p of layer) {
                        const n = serverInstance!.getIndexData().find(x => x.path === p);
                        const degOut = serverInstance!.getOutgoingPathsPub(p).length;
                        const degIn = serverInstance!.getBacklinkPathsPub(p).length;
                        lines.push(`- ${p} (${(n?.title) || ''}) out:${degOut} in:${degIn}`);
                    }
                });
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            }
        }
        if (request.params.name === "resolve-note") {
            const input = String((request.params.arguments || {} as any).input || '');
            if (!input)
                throw new Error('input is required');
            const res = serverInstance!.resolveNotePublic(input);
            return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
        }
        if (request.params.name === "vault-browse") {
            const args = request.params.arguments || {} as any;
            const mode = String(args.mode || 'tree');
            if (mode === 'tree') {
                const tree = serverInstance!.buildVaultTree({ root: args.root, maxDepth: args.maxDepth, includeFiles: args.includeFiles, includeCounts: args.includeCounts, sort: args.sort, limitPerDir: args.limitPerDir });
                if ((args.format || 'text') === 'json') {
                    return { content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }] };
                }
                const lines: string[] = [];
                const walk = (node: any, depth: number) => {
                    const indent = '  '.repeat(depth);
                    if (node.type === 'directory') {
                        const info = node.counts ? ` (md: ${node.counts.md_files || 0}${node.mtimeLatest ? `, latest: ${node.mtimeLatest.slice(0, 10)}` : ''})` : '';
                        lines.push(`${indent}${node.path || node.name}${info}`);
                        for (const c of node.children || [])
                            walk(c, depth + 1);
                    }
                    else {
                        lines.push(`${indent}- ${node.name}${node.mtime ? ` (${node.mtime})` : ''}`);
                    }
                };
                walk(tree, 0);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            }
            else {
                const rows = serverInstance!.buildFolderContents({ folderPath: String(args.folderPath || ''), recursive: args.recursive, sortBy: args.sortBy, limit: args.limit, filter: args.filter });
                if ((args.format || 'text') === 'json') {
                    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
                }
                if ((args.format || 'text') === 'table') {
                    const header: string[] = ['Title', 'Path', 'mtime', 'in', 'out'];
                    const widths: number[] = [
                        Math.max(header[0].length, ...rows.map(r => (r.title || '').length)),
                        Math.max(header[1].length, ...rows.map(r => (r.path || '').length)),
                        Math.max(header[2].length, ...rows.map(r => (r.mtime || '').length)),
                        Math.max(header[3].length, ...rows.map(r => String(r.degreeIn).length)),
                        Math.max(header[4].length, ...rows.map(r => String(r.degreeOut).length))
                    ];
                    const pad = (s: string, w: number): string => (s + ' '.repeat(Math.max(0, w - s.length)));
                    const line = (cols: Array<string | number>): string => cols.map((c, i) => pad(String(c), widths[i])).join('  ');
                    const lines: string[] = [line(header), line(widths.map(w => '-'.repeat(w)))];
                    for (const r of rows)
                        lines.push(line([r.title, r.path, r.mtime || '', r.degreeIn, r.degreeOut]));
                    return { content: [{ type: 'text', text: lines.join('\n') }] };
                }
                const text = rows.map(r => `- ${r.title} — ${r.path}  (mtime: ${r.mtime}, in:${r.degreeIn} out:${r.degreeOut})`).join('\n');
                return { content: [{ type: 'text', text }] };
            }
        }
        throw new Error(`Unknown tool: ${request.params.name}`);
    });
    return server;
}
async function main() {
    console.error("═══════════════════════════════════════════════════════════════");
    console.error("🚀 OBSIDIAN MCP SERVER STARTING UP");
    console.error("═══════════════════════════════════════════════════════════════");
    console.error(`📅 Timestamp: ${new Date().toISOString()}`);
    console.error(`🔧 Node.js version: ${process.version}`);
    console.error(`📁 Working directory: ${process.cwd()}`);
    console.error(`🛠️ Script location: ${__filename}`);
    console.error(`🔍 Plugin root: ${PLUGIN_ROOT}`);
    console.error("---------------------------------------------------------------");
    const server = createServer();
    const transport = new StdioServerTransport();
    console.error("🔌 Connecting to MCP transport...");
    await server.connect(transport);
    console.error("✅ SERVER SUCCESSFULLY STARTED!");
    console.error("🔍 Obsidian Notes MCP Server running on stdio");
    console.error("🎯 Ready to receive search requests...");
    console.error("🎯 PRODUCTION MODE: Advanced search operators now working!");
    console.error(`📅 Build: v2.6.0-advanced-search (${new Date().toLocaleDateString()})`);
    console.error("═══════════════════════════════════════════════════════════════");
}
main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
