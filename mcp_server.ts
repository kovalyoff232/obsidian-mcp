#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { 
  CallToolRequestSchema,
  ListToolsRequestSchema 
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "url";
import path from "path";
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, statSync, rmSync } from "fs";
import Fuse from "fuse.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Interfaces для локальной документации заметок (адаптированы под существующий index.json)
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
  fullPath?: string; // Полный путь к оригинальному файлу для чтения всего содержимого
  aliases?: string[];
  type?: string;
}

// 🔍 РАСШИРЕННЫЕ ОПЕРАТОРЫ ПОИСКА (как в Google!)
interface ParsedQuery {
  terms: string[];           // Обычные термины
  exactPhrases: string[];    // "точные фразы" 
  requiredTerms: string[];   // +обязательные
  excludedTerms: string[];   // -исключенные
  fieldQueries: {field: string, value: string}[]; // title:значение
  operators: {type: 'AND' | 'OR', terms: string[]}[]; // AND/OR группы
}

// 📊 КАТЕГОРИЗАЦИЯ РЕЗУЛЬТАТОВ ПО ТИПАМ
enum NoteCategory {
  DOCUMENTATION = '📚 Документация',
  PROJECT_SPEC = '📋 ТЗ и Спецификации', 
  TUTORIAL = '🎓 Обучение',
  CODE_SAMPLES = '💻 Примеры кода',
  TODO_TASKS = '✅ Задачи и TODO',
  PERSONAL_NOTES = '📝 Личные заметки',
  REFERENCE = '🔖 Справочники',
  OTHER = '📄 Прочее'
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

    // СНАЧАЛА извлекаем поиск по полям (title:значение, path:значение, tags:значение), поддерживаем кавычки
    // Примеры: title:Антидепрессанты, title:"Анти депрессанты"
    const fieldRegex = /([\w\.]+):(?:"([^"]+)"|([^\s]+))/g; // поддержка fm.key
    let match;
    while ((match = fieldRegex.exec(query)) !== null) {
      const field = (match[1] || '').toLowerCase();
      const value = (match[2] || match[3] || '').toLowerCase();
      if (field && value) {
        result.fieldQueries.push({ field, value });
      }
      query = query.replace(match[0], ''); // Удаляем обработанную часть
    }

    // Затем извлекаем точные фразы в кавычках, оставшиеся вне field-запросов
    const phraseRegex = /"([^"]+)"/g;
    while ((match = phraseRegex.exec(query)) !== null) {
      result.exactPhrases.push((match[1] || '').toLowerCase());
      query = query.replace(match[0], '');
    }

    // Разбиваем оставшийся запрос на слова
    const words = query.split(/\s+/).filter(word => word.trim().length > 0);

    for (const word of words) {
      const trimmed = word.trim().toLowerCase();
      if (!trimmed) continue;

      if (trimmed.startsWith('+')) {
        // +обязательное слово
        const term = trimmed.substring(1);
        if (term.length > 0) result.requiredTerms.push(term);
      } else if (trimmed.startsWith('-')) {
        // -исключенное слово
        const term = trimmed.substring(1);
        if (term.length > 0) result.excludedTerms.push(term);
      } else if (trimmed === 'and' || trimmed === 'or') {
        // Пропускаем операторы, они обработаются отдельно
        continue;
      } else {
        // Обычное слово
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

    // Анализируем по пути
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

    // Анализируем по заголовку и содержанию
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

const DEFAULT_LIMIT = 20; // 🎯 Увеличили по просьбе пользователя для больше результатов

// Определяем путь к файлу индекса
const SCRIPT_DIR = path.dirname(__filename);
const PLUGIN_ROOT = path.join(SCRIPT_DIR, '..');

function findIndexPath(): string {
  const indexPath = path.join(PLUGIN_ROOT, 'index.json');
  console.error(`🔍 Looking for index.json at: ${indexPath}\n`);
  console.error(`🔍 Script dir: ${SCRIPT_DIR}`);
  console.error(`🔍 Plugin root: ${PLUGIN_ROOT}`);
  return indexPath;
}

// Singleton instance защита

// Защита от множественных экземпляров сервера
let serverInstance: ObsidianMCPServer | null = null;

class ObsidianMCPServer {
  private indexData: ObsidianNote[] = [];
  private synonyms: Record<string, string[]> = {};
  private categories: Record<string, string[]> = {};
  private isLoaded: boolean = false;
  private vaultPath: string = ''; // Путь к vault для доступа к полным файлам
  private fuse: Fuse<ObsidianNote> | null = null; // Fuse.js поисковик
  
  // Индекс-ревизия (увеличивается при любой переиндексации/изменении)
  private indexRevision: number = 0;

  // Быстрый обратный индекс: targetPath -> Set<sourcePath>
  private backlinkIndex: Map<string, Set<string>> = new Map();
  
  // 🚀 УМНОЕ КЭШИРОВАНИЕ ПОИСКА
  private searchCache = new Map<string, {results: SearchResult[], timestamp: number, hitCount: number}>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 минут
  private readonly MAX_CACHE_SIZE = 100; // Максимум 100 запросов в кэше

  // Кэш тяжёлых графовых/навигационных ответов
  private heavyCache = new Map<string, { value: any; ts: number }>();
  private readonly HEAVY_TTL = 3 * 60 * 1000; // 3 минуты
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

  // Дебаунс для инкрементальной индексации
  private indexDebounceTimers: Map<string, NodeJS.Timeout> = new Map();

  // 🔬 Семантический слой (скелет): включение/хранилище
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
  
  // 📊 АНАЛИТИКА И СТАТИСТИКА
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

  // 🔤 Морфология: динамические стеммеры (если доступны в окружении)
  private stemLibsInitialized: boolean = false;
  private ruStemFn?: (word: string) => string;
  private enStemFn?: (word: string) => string;

  constructor() {
    this.synonyms = this._loadSynonyms();
    // Подмешиваем пользовательские синонимы из vault (если найдём)
    try {
      const userSyn = this._loadUserSynonymsFromVault();
      if (userSyn && Object.keys(userSyn).length > 0) {
        for (const [k, arr] of Object.entries(userSyn)) {
          const base = this.synonyms[k] || [];
          this.synonyms[k] = [...new Set([...base, ...arr])];
        }
        console.error(`🧩 User synonyms merged: +${Object.keys(userSyn).length} entries`);
      }
    } catch {}
    this.categories = this._initCategories();
    this.vaultPath = this.findVaultPath();
    // Инициализируем внешние стеммеры в фоне (не блокируем запуск)
    this.initStemLibsAsync();
    // Семантический слой: флаг из окружения
    this.semanticEnabled = (process.env.MCP_SEMANTIC_ENABLED === 'true');
    this.embedPersist = (process.env.MCP_SEMANTIC_PERSIST !== 'false');
    this.embedStorePath = process.env.MCP_SEMANTIC_STORE || path.join(PLUGIN_ROOT, 'semantic_index.json');
    this.embedBackup = (process.env.MCP_SEMANTIC_BACKUP !== 'false');
    console.error(`🧠 Semantic layer ${this.semanticEnabled ? 'ENABLED' : 'disabled'} (env MCP_SEMANTIC_ENABLED)`);
    console.error(`💾 Semantic persist ${this.embedPersist ? 'ON' : 'off'} → ${this.embedStorePath} (backup ${this.embedBackup ? 'ON' : 'off'})`);
    try { this.loadEmbedStoreFromDisk(); } catch (e) { console.error('⚠️ semantic store load failed:', e); }
    // Инициализация провайдера эмбеддингов (в фоне)
    try { this.initEmbedProviderAsync(); } catch {}
  }

  // Готовые пресеты сложных запросов
  public getQueryPresets(): Record<string, string> {
    return {
      // Структура/таксономия
      'classes:all': 'type:class',
      'taxonomy:all': 'tags:taxonomy',
      'taxonomy:drugs': 'tags:"drug-class"',

      // Фармакология
      'pharma:antidepressants': 'path:Антидепрессанты',
      'pharma:ssri': '+SSRI fm.taxonomy:"Антидепрессанты"',
      'pharma:ai-drafts': 'fm.source:ai fm.type:class path:Фармакология',

      // Obsidian/инструменты
      'obsidian:plugins': 'path:graph/ Knowledge Hub/ Инструменты/ Шаблонизация/ Плагины',
      'obsidian:templating': 'path:Шаблонизация related:Templater',

      // Качество/черновики
      'drafts:ai': 'fm.source:ai status:draft',
      'drafts:non-ai': '-fm.source:ai status:draft',

      // Дедуп/диагностика
      'diagnostics:has-hub-link': 'content:"[[Knowledge Hub]]" -type:class',
      'diagnostics:leaf-direct-hub': 'related:"Knowledge Hub" -type:class',

      // Навигация по алиасам
      'aliases:antidepressants': 'aliases:"Antidepressants"',
    };
  }

  loadIndexSync() {
    if (this.isLoaded) return;
    
    // Асинхронно загружаем index для избежания блокировки
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
    if (!e) return null;
    if (Date.now() - e.ts > this.HEAVY_TTL) { this.heavyCache.delete(key); return null; }
    return e.value;
  }

  private heavySet(key: string, value: any) {
    // simple LRU-ish: delete oldest entry when exceeding limit
    if (this.heavyCache.size >= this.HEAVY_MAX) {
      const firstKey = this.heavyCache.keys().next().value;
      if (firstKey) this.heavyCache.delete(firstKey);
    }
    this.heavyCache.set(key, { value, ts: Date.now() });
  }

  // Определяем путь к vault
  private findVaultPath(): string {
    // Путь от plugin root до vault root
    // /path/to/vault/.obsidian/plugins/obsidian-mcp-plugin -> /path/to/vault/
    const vaultPath = path.join(PLUGIN_ROOT, '../../../');
    const normalizedPath = path.resolve(vaultPath);
    console.error(`📂 Vault path detected: ${normalizedPath}/`);
    console.error(`📂 Plugin root dir: ${PLUGIN_ROOT}`);
    return normalizedPath;
  }

  // Загружаем индекс заметок
  async loadIndex(): Promise<void> {
    try {
      const INDEX_PATH = findIndexPath();
      console.error(`🔍 Attempting to load index from: ${INDEX_PATH}\n`);
      
      if (existsSync(INDEX_PATH)) {
        const rawData = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
        console.error(`🔍 Raw data contains ${rawData.length} items`);
        console.error(`🔍 First item keys:`, Object.keys(rawData[0] || {}));
        
        // Проверяем что данные в правильном формате
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
            fullPath: path.join(this.vaultPath, item.path) // Добавляем полный путь к файлу
          }));
        
        // Загружаем полное содержимое всех заметок для лучшего поиска
        await this.loadFullContent();
        
        // Инициализируем Fuse.js поиск
        this.initializeFuse();
        
        this.isLoaded = true;
        
        // Перестроить обратный индекс и инкрементировать ревизию
        this.rebuildBacklinkIndex();
        this.bumpRevisionAndInvalidate();
        
        console.error(`✅ Successfully loaded ${this.indexData.length} notes from index`);
        console.error(`🚀 Fuse.js search engine initialized with full content`);
      } else {
        console.error(`❌ Index file not found: ${INDEX_PATH}`);
        console.error(`💡 Make sure your Obsidian notes are properly indexed`);
      }
    } catch (error) {
      console.error(`❌ Error loading index:`, error);
    }
  }

  // Загружаем полное содержимое всех заметок
  private async loadFullContent(): Promise<void> {
    console.error(`📄 Loading full content for ${this.indexData.length} notes...`);
    
    for (const note of this.indexData) {
      if (note.fullPath && existsSync(note.fullPath)) {
        try {
          note.content = readFileSync(note.fullPath, 'utf-8');
          // 🔎 Parse frontmatter tags into in-memory index for tags: filtering
          try {
            const { frontmatter } = this.parseFrontmatterAndBody(note.content || '');
            const fmTags = (frontmatter && frontmatter['tags']) as any;
            if (Array.isArray(fmTags)) {
              note.tags = fmTags.map((t: any) => String(t));
            } else if (typeof fmTags === 'string' && fmTags.trim().length > 0) {
              note.tags = fmTags.split(/[\s,]+/).filter(Boolean);
            }
            const fmAliases = (frontmatter && frontmatter['aliases']) as any;
            if (Array.isArray(fmAliases)) {
              note.aliases = fmAliases.map((t: any) => String(t));
            } else if (typeof fmAliases === 'string' && fmAliases.trim().length > 0) {
              note.aliases = fmAliases.split(/[\s,]+/).filter(Boolean);
            }
            if (typeof frontmatter?.['type'] === 'string') {
              note.type = frontmatter['type'];
            }
          } catch {}
        } catch (error) {
          console.error(`❌ Failed to read ${note.fullPath}:`, error);
          // Используем preview если не можем прочитать полный файл
          note.content = note.content_preview || '';
        }
      } else {
        // Используем preview если файл не найден
        note.content = note.content_preview || '';
      }
    }
    
    console.error(`📚 Loaded full content for ${this.indexData.length}/${this.indexData.length} notes`);
  }

  // ПУБЛИЧНО: Полная переиндексация vault и перезагрузка поискового движка
  public async reindexVault(): Promise<{ notes: number }> {
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
          if (shouldExclude(relDir + '/')) continue;
          walk(full);
        } else if (st.isFile() && entry.toLowerCase().endsWith('.md')) {
          const rel = path.relative(vaultRoot, full).replace(/\\/g, '/');
          if (shouldExclude(rel)) continue;
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
    } catch (e) {
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

  // Инициализируем Fuse.js для мощного fuzzy поиска
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
        if (typeof val === 'string') return this.normalizeQuery(val);
        if (Array.isArray(val)) return val.map(v => typeof v === 'string' ? this.normalizeQuery(v) : v);
        return val;
      }
    };

    this.fuse = new Fuse(this.indexData, fuseOptions as any);
    console.error(`🔧 Fuse.js initialized [mode=${mode}] with ${this.indexData.length} searchable notes`);
  }

  // Инкрементальная индексация одного файла
  private indexSingleFile(relativePathInput: string): void {
    try {
      const INDEX_PATH = findIndexPath();
      const rel = relativePathInput.replace(/^\/+/, '');
      const relWithExt = rel.toLowerCase().endsWith('.md') ? rel : `${rel}.md`;
      const full = path.resolve(this.vaultPath, relWithExt);
      if (!existsSync(full)) return;
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
      } else {
        this.indexData.push({ ...updated, id: `note_${this.indexData.length}` });
      }

      // моментально обновляем содержимое и перестраиваем Fuse
      const noteRef = this.indexData.find(n => n.path === relWithExt)!;
      noteRef.content = content;
      this.initializeFuse();
      this.rebuildBacklinkIndex();
      this.bumpRevisionAndInvalidate();

      // сохраняем индекс на диск
      try {
        writeFileSync(INDEX_PATH, JSON.stringify(this.indexData.map(n => ({
          path: n.path,
          content_preview: n.content_preview,
          title: n.title,
          description: n.description,
          lastModified: n.lastModified,
          fullPath: n.fullPath
        })), null, 2), { encoding: 'utf-8' });
      } catch (e) {
        console.error('❌ Failed to persist incremental index:', e);
      }
    } catch (e) {
      console.error('❌ indexSingleFile error:', e);
    }
  }

  // Поставить задачу на отложенную индексацию одного файла
  private scheduleIndexSingleFile(relativePathInput: string, delayMs?: number): void {
    try {
      const rel = relativePathInput.replace(/^\/+/, '');
      const relWithExt = rel.toLowerCase().endsWith('.md') ? rel : `${rel}.md`;
      // сбросить предыдущий таймер
      const t = this.indexDebounceTimers.get(relWithExt);
      if (t) { clearTimeout(t); this.indexDebounceTimers.delete(relWithExt); }
      const delay = Math.max(50, typeof delayMs === 'number' ? delayMs : this.INDEX_DEBOUNCE_MS);
      const timer = setTimeout(() => {
        try { this.indexSingleFile(relWithExt); } catch {}
        // Планируем обновление эмбеддинга для файла (если включена семантика или персист)
        try { this.scheduleEmbedUpdate(relWithExt); } catch {}
        this.indexDebounceTimers.delete(relWithExt);
      }, delay);
      this.indexDebounceTimers.set(relWithExt, timer);
    } catch {}
  }

  // Расширяем поисковый запрос синонимами
  private expandQueryWithSynonyms(query: string): string[] {
    const expandedQueries: string[] = [];
    const queryLower = (query || '').toLowerCase();
    expandedQueries.push(queryLower);
    const normalized = this.normalizeQuery(queryLower);
    if (normalized && normalized !== queryLower) expandedQueries.push(normalized);

    // Добавляем синонимы из словаря
    for (const [key, synonyms] of Object.entries(this.synonyms)) {
      if (key === queryLower || synonyms.some(syn => queryLower.includes(syn))) {
        expandedQueries.push(key);
        expandedQueries.push(...synonyms);
      }
    }

    // Убираем дубликаты и возвращаем уникальные запросы
    return [...new Set(expandedQueries.filter(Boolean))];
  }

  // 🎯 НОВАЯ ФИЧА: Подсвечиваем найденные слова в тексте!
  private highlightMatches(text: string, query: string): string {
    if (!text || !query) return text;

    // Получаем все слова из запроса для подсветки
    const queryWords = this.extractQueryWords(query);
    
    let highlightedText = text;
    
    // Подсвечиваем каждое найденное слово
    for (const word of queryWords) {
      if (word.length < 2) continue; // Пропускаем слишком короткие слова
      
      const regex = new RegExp(`(${this.escapeRegex(word)})`, 'gi');
      highlightedText = highlightedText.replace(regex, '**$1**'); // Жирным выделяем
    }

    return highlightedText;
  }

  // Извлекаем слова из запроса для подсветки
  private extractQueryWords(query: string): string[] {
    const words = (query || '').toLowerCase()
      .split(/[\s\-_.,;:!?()[\]{}"']+/)
      .filter(word => word.length >= 2)
      .filter(word => !/^\d+$/.test(word))
      .map(w => this.normalizeWord(w));

    // Добавляем синонимы для найденных слов
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

  // Экранируем специальные символы для regex
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // --- Новая морфология: нормализация RU/EN ---
  private normalizeWord(word: string): string {
    if (!word) return word;
    let w = word.toLowerCase();
    if (/^\d+$/.test(w)) return w;
    // Попытка использовать внешние стеммеры, если они доступны
    const hasCyrillic = /[\u0400-\u04FF]/.test(w);
    try {
      if (hasCyrillic && this.ruStemFn) {
        const stemmed = this.ruStemFn(w);
        if (typeof stemmed === 'string' && stemmed.length >= 2) return stemmed;
      }
      if (!hasCyrillic && this.enStemFn) {
        const stemmed = this.enStemFn(w);
        if (typeof stemmed === 'string' && stemmed.length >= 2) return stemmed;
      }
    } catch {}

    // Фолбэк: ручной набор суффиксов
    const enSuffixes = ['ingly','edly','ments','ations','ation','ingly','edly','ment','ness','ingly','ing','edly','ed','ions','ion','ers','er','es','ly','s'];
    for (const suf of enSuffixes) {
      if (w.endsWith(suf) && w.length - suf.length >= 3) { w = w.slice(0, -suf.length); break; }
    }
    const ruSuffixes = ['иями','ями','ами','ыми','ими','кого','кому','ому','его','ему','ого','ее','ие','ые','ая','яя','ою','ею','ую','ью','ой','ый','ий','ых','ов','ев','ам','ям','ах','ях','ом','ем','ую','ию','ешь','ишь','ать','ять','ить','ешься','ишься','аться','яться','итьcя','иваться','ываться','овать','ирование','ированн','ирование','ение','ений','ениям','ениями','енией'];
    for (const suf of ruSuffixes) {
      if (w.endsWith(suf) && w.length - suf.length >= 3) { w = w.slice(0, -suf.length); break; }
    }
    return w;
  }

  private normalizeQuery(query: string): string {
    const parts = (query || '').toLowerCase().split(/[\s\-_.,;:!?()[\]{}"']+/).filter(Boolean);
    const normalized = parts.map(p => this.normalizeWord(p));
    return Array.from(new Set(normalized)).join(' ');
  }

  // Ленивая инициализация внешних стеммеров (если они установлены как зависимости)
  private initStemLibsAsync(): void {
    if (this.stemLibsInitialized) return;
    this.stemLibsInitialized = true;
    // Английский: natural.PorterStemmer
    const natPkg = 'natural';
    (import(natPkg as any) as any).then((mod: any) => {
      try {
        const ps = mod?.PorterStemmer;
        if (ps && typeof ps.stem === 'function') {
          this.enStemFn = (w: string) => {
            try { return ps.stem(w); } catch { return w; }
          };
          console.error('✅ EN stemmer (natural) initialized');
        }
      } catch {}
    }).catch(() => {});
    // Русский: попытаться несколько популярных пакетов
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
          if (typeof mod?.stem === 'function') fn = mod.stem;
          else if (typeof mod?.default === 'function') fn = mod.default;
          else if (mod?.default && typeof mod.default.stem === 'function') fn = mod.default.stem;
          if (fn) {
            this.ruStemFn = (w: string) => { try { return fn!(w); } catch { return w; } };
            console.error(`✅ RU stemmer initialized from ${pkg}`);
          }
        } catch {}
      }).catch(() => {});
    }
  }

  // 🔍 Умно извлекаем контекст вокруг найденных слов
  private extractRelevantSnippet(text: string, query: string, maxLength: number = 300): string {
    if (!text || text.length <= maxLength) return text;

    const queryWords = this.extractQueryWords(query);
    let bestPosition = 0;
    let maxMatches = 0;

    // Ищем участок текста с максимальным количеством совпадений
    const windowSize = maxLength;
    for (let i = 0; i <= text.length - windowSize; i += Math.floor(windowSize / 3)) {
      const window = text.substring(i, i + windowSize).toLowerCase();
      let matches = 0;
      
      for (const word of queryWords) {
        const regex = new RegExp(this.escapeRegex(word), 'gi');
        const wordMatches = window.match(regex);
        if (wordMatches) matches += wordMatches.length;
      }
      
      if (matches > maxMatches) {
        maxMatches = matches;
        bestPosition = i;
      }
    }

    // Извлекаем лучший участок
    let snippet = text.substring(bestPosition, bestPosition + maxLength);
    
    // Добавляем троеточие если это не начало/конец
    if (bestPosition > 0) snippet = '...' + snippet;
    if (bestPosition + maxLength < text.length) snippet = snippet + '...';
    
    return snippet;
  }

  // 🔗 ПОИСК ПО СВЯЗЯМ МЕЖДУ ЗАМЕТКАМИ!
  private findLinkedNotes(noteId: string, maxDepth: number = 2): ObsidianNote[] {
    if (!this.indexData || maxDepth <= 0) return [];

    const visited = new Set<string>();
    const linkedNotes: ObsidianNote[] = [];
    const queue: {note: ObsidianNote, depth: number}[] = [];

    // Находим исходную заметку
    const startNote = this.indexData.find(note => 
      note.id === noteId || note.path === noteId || note.title === noteId
    );
    
    if (!startNote) return [];
    
    queue.push({note: startNote, depth: 0});
    visited.add(startNote.id || startNote.path);

    while (queue.length > 0) {
      const {note, depth} = queue.shift()!;
      
      if (depth > 0) {
        linkedNotes.push(note);
      }

      if (depth < maxDepth && note.links) {
        // Ищем заметки, на которые ссылается текущая
        for (const link of note.links) {
          if (!visited.has(link)) {
            const linkedNote = this.indexData.find(n => 
              n.id === link || n.path === link || n.title === link
            );
            if (linkedNote) {
              visited.add(linkedNote.id || linkedNote.path);
              queue.push({note: linkedNote, depth: depth + 1});
            }
          }
        }
      }

      // Ищем заметки, которые ссылаются на текущую
      if (depth < maxDepth) {
        const backlinks = this.indexData.filter(n => 
          n.links && n.links.some(link => 
            link === (note.id || note.path || note.title)
          ) && !visited.has(n.id || n.path)
        );
        
        for (const backlink of backlinks) {
          visited.add(backlink.id || backlink.path);
          queue.push({note: backlink, depth: depth + 1});
        }
      }
    }

    return linkedNotes;
  }

  // Улучшенный поиск с учетом связей
  private searchWithLinks(query: string, baseResults: SearchResult[], includeLinked: boolean = true): SearchResult[] {
    if (!includeLinked || baseResults.length === 0) return baseResults;

    // 🎯 УМНАЯ ЛОГИКА: связанные заметки только если есть хорошие основные результаты
    const highQualityResults = baseResults.filter(r => r.score < 0.2); // 🎯 ФИНАЛ: только для очень хороших результатов
    if (highQualityResults.length === 0) {
      console.error(`🔗 Skipping linked notes: no high-quality base results found`);
      return baseResults; // Не добавляем связанные если основные результаты слабые
    }

    const enhancedResults: SearchResult[] = [...baseResults];
    const addedIds = new Set(baseResults.map(r => r.id));

    // Для каждого найденного результата ищем связанные заметки
    for (const result of baseResults.slice(0, 2)) { // 🎯 Берем только топ-2 (было 5)
      const linkedNotes = this.findLinkedNotes(result.id, 1); // Глубина 1 уровень
      
      for (const linkedNote of linkedNotes.slice(0, 1)) { // 🎯 Максимум 1 связанная на результат (было 3)
        const linkedId = linkedNote.id || linkedNote.path;
        if (!addedIds.has(linkedId)) {
          addedIds.add(linkedId);
          
          const linkedResult: SearchResult = {
            id: linkedId,
            title: `🔗 ${this.highlightMatches(linkedNote.title || 'Untitled', query)}`,
            description: `Связано с: "${result.title.replace(/\*\*/g, '')}" | ${this.highlightMatches(linkedNote.description || '', query)}`,
            path: linkedNote.path,
            lastModified: linkedNote.lastModified || '',
            score: result.score * 0.7, // Понижаем score для связанных заметок
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

    // Сортируем результаты: сначала основные, потом связанные по score
    return enhancedResults.sort((a, b) => {
      if (a.type === 'fuse_match' && b.type === 'linked_note') return -1;
      if (a.type === 'linked_note' && b.type === 'fuse_match') return 1;
      return b.score - a.score;
    });
  }

  // 🔧 Отладочный метод для диагностики расширенной фильтрации
  private debugAdvancedFilter(note: ObsidianNote, parsedQuery: ParsedQuery): boolean {
    const searchableText = [
      note.title || '',
      note.description || '',
      note.content || note.content_preview || '',
      note.path,
      (note.tags || []).join(' ')
    ].join(' ').toLowerCase();

    console.error(`🔍 Searchable text sample: "${searchableText.substring(0, 100)}..."`);

    // Проверяем точные фразы
    for (const phrase of parsedQuery.exactPhrases) {
      const found = searchableText.includes(phrase);
      console.error(`🔍 Exact phrase "${phrase}": ${found}`);
      if (!found) return false;
    }

    // Проверяем обязательные термины
    for (const required of parsedQuery.requiredTerms) {
      const found = searchableText.includes(required);
      console.error(`🔍 Required term "${required}": ${found}`);
      if (!found) return false;
    }

    // Проверяем исключенные термины
    for (const excluded of parsedQuery.excludedTerms) {
      const found = searchableText.includes(excluded);
      console.error(`🔍 Excluded term "${excluded}": ${found} (should be false)`);
      if (found) return false;
    }

    // Проверяем поиск по полям
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
          // fm.<key> поддержка
          if (fieldQuery.field.startsWith('fm.')) {
            const fmKey = fieldQuery.field.slice(3);
            try {
              const { frontmatter } = this.parseFrontmatterAndBody(note.content || '');
              const raw = frontmatter?.[fmKey];
              if (Array.isArray(raw)) fieldValue = raw.join(' ').toLowerCase();
              else if (raw != null) fieldValue = String(raw).toLowerCase();
            } catch {}
          }
      }
      
      const found = fieldValue.includes(fieldQuery.value);
      console.error(`🔍 Field ${fieldQuery.field}:"${fieldQuery.value}": ${found} (field value: "${fieldValue.substring(0, 50)}...")`);
      if (!found) return false;
    }

    return true;
  }

  // Фильтруем результаты по расширенным операторам
  private filterByAdvancedQuery(results: SearchResult[], parsedQuery: ParsedQuery, originalNotes: ObsidianNote[]): SearchResult[] {
    return results.filter(result => {
      const note = originalNotes.find(n => (n.id || n.path) === result.id);
      if (!note) return false;

      const searchableText = [
        note.title || '',
        note.description || '',
        note.content || note.content_preview || '',
        note.path,
        (note.tags || []).join(' ')
      ].join(' ').toLowerCase();

      // Проверяем точные фразы
      for (const phrase of parsedQuery.exactPhrases) {
        if (!searchableText.includes(phrase)) return false;
      }

      // Проверяем обязательные термины
      for (const required of parsedQuery.requiredTerms) {
        if (!searchableText.includes(required)) return false;
      }

      // Проверяем исключенные термины
      for (const excluded of parsedQuery.excludedTerms) {
        if (searchableText.includes(excluded)) return false;
      }

      // Проверяем поиск по полям
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
                if (Array.isArray(raw)) fieldValue = raw.join(' ').toLowerCase();
                else if (raw != null) fieldValue = String(raw).toLowerCase();
              } catch {}
            }
        }
        
        if (!fieldValue.includes(fieldQuery.value)) return false;
      }

      return true;
    });
  }

  // Группируем результаты по категориям
  private categorizeResults(results: SearchResult[]): Map<NoteCategory, SearchResult[]> {
    const categorized = new Map<NoteCategory, SearchResult[]>();
    
    // Инициализируем все категории
    Object.values(NoteCategory).forEach(category => {
      categorized.set(category, []);
    });

    // Распределяем результаты по категориям
    for (const result of results) {
      const note = this.indexData.find(n => (n.id || n.path) === result.id);
      if (note) {
        const category = NoteCategorizer.categorize(note);
        categorized.get(category)!.push(result);
      }
    }

    return categorized;
  }

  // Форматируем результаты с категориями (БЕЗ заголовков для чистоты)
  private formatCategorizedResults(categorized: Map<NoteCategory, SearchResult[]>, limit: number): SearchResult[] {
    const formatted: SearchResult[] = [];
    let totalAdded = 0;

    // Определяем приоритет категорий (документация и ТЗ важнее)
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
      if (categoryResults.length === 0) continue;

      // 🎯 УБРАЛИ заголовки категорий - просто добавляем результаты
      for (const result of categoryResults) {
        if (totalAdded >= limit) break;
        
        // Добавляем тип категории к результату (но БЕЗ отдельного заголовка)
        const enhancedResult = {
          ...result,
          description: `[${category}] ${result.description}`, // Показываем категорию в описании
          type: result.type === 'linked_note' ? 'linked_note' : 'categorized_result'
        };
        
        formatted.push(enhancedResult);
        totalAdded++;
      }

      if (totalAdded >= limit) break;
    }

    return formatted;
  }

  // 🚀 МЕТОДЫ УМНОГО КЭШИРОВАНИЯ
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
    if (this.searchCache.size < this.MAX_CACHE_SIZE) return;
    
    // Находим запись с наименьшим количеством обращений
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
        // Увеличиваем счетчик обращений
        cached.hitCount++;
        cached.timestamp = now; // Обновляем время последнего доступа
        console.error(`⚡ Cache HIT for "${query}" (hits: ${cached.hitCount})`);
        return [...cached.results]; // Возвращаем копию
      } else {
        // Удаляем устаревший кэш
        this.searchCache.delete(key);
      }
    }
    
    console.error(`💾 Cache MISS for "${query}"`);
    return null;
  }

  private setCachedResult(query: string, limit: number, results: SearchResult[]): void {
    const key = this.getCacheKey(query, limit);
    
    // Очищаем место если нужно
    this.evictLeastUsedCache();
    
    this.searchCache.set(key, {
      results: [...results], // Сохраняем копию
      timestamp: Date.now(),
      hitCount: 1
    });
    
    console.error(`💾 Cached results for "${query}" (cache size: ${this.searchCache.size}/${this.MAX_CACHE_SIZE})`);
  }

  // Очищаем кэш при обновлении индекса
  private clearCache(): void {
    this.searchCache.clear();
    console.error(`🗑️ Search cache cleared`);
  }

  // 📊 МЕТОДЫ АНАЛИТИКИ И СТАТИСТИКИ
  private recordSearchAnalytics(query: string, searchTime: number, resultsCount: number, hasAdvancedOperators: boolean, linkedNotesCount: number, categories: Map<NoteCategory, SearchResult[]>): void {
    this.searchStats.totalSearches++;
    
    // Записываем популярные запросы
    const normalizedQuery = query.toLowerCase().trim();
    this.searchStats.popularQueries.set(normalizedQuery, (this.searchStats.popularQueries.get(normalizedQuery) || 0) + 1);
    
    // Записываем популярные слова
    const words = normalizedQuery.split(/\s+/).filter(w => w.length > 2);
    for (const word of words) {
      this.searchStats.popularWords.set(word, (this.searchStats.popularWords.get(word) || 0) + 1);
    }
    
    // Время поиска
    this.searchStats.avgSearchTime = (this.searchStats.avgSearchTime + searchTime) / 2;
    
    // Время дня
    const hour = new Date().getHours();
    this.searchStats.searchesByHour[hour]++;
    
    // Продвинутые операторы
    if (hasAdvancedOperators) {
      this.searchStats.advancedOperatorsUsed++;
    }
    
    // Связанные заметки
    this.searchStats.linkedNotesFound += linkedNotesCount;
    
    // Категории
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
    
    // Топ популярных запросов
    const topQueries = Array.from(stats.popularQueries.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([query, count]) => `"${query}": ${count}`)
      .join(', ');
      
    // Топ популярных слов
    const topWords = Array.from(stats.popularWords.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word, count]) => `${word}(${count})`)
      .join(', ');
      
    // Самый активный час
    const peakHour = stats.searchesByHour.indexOf(Math.max(...stats.searchesByHour));
    
    return `
📊 СТАТИСТИКА ПОИСКА:
🔍 Всего поисков: ${stats.totalSearches}
⚡ Cache Hit Rate: ${cacheHitRate}% (${stats.cacheHits}/${stats.totalSearches})
⏱️ Среднее время: ${stats.avgSearchTime.toFixed(1)}ms
🕐 Пиковый час: ${peakHour}:00 (${stats.searchesByHour[peakHour]} поисков)
🔗 Связанных заметок найдено: ${stats.linkedNotesFound}
🔍 Продвинутые операторы: ${stats.advancedOperatorsUsed} раз
📈 Популярные запросы: ${topQueries || 'нет данных'}
🏷️ Популярные слова: ${topWords || 'нет данных'}
    `.trim();
  }

  // ИДЕАЛЬНЫЙ ПОИСК с Fuse.js!
  public searchNotes(query: string, limit: number = DEFAULT_LIMIT, options?: { mode?: 'balanced'|'taxonomy', includeLinked?: boolean }): SearchResult[] {
    const mode = options?.mode || 'balanced';
    const includeLinked = options?.includeLinked !== false;
    if (!this.fuse || !this.indexData || this.indexData.length === 0) {
      console.error(`❌ Search engine not initialized`);
      return [];
    }

    // 📊 Засекаем время поиска
    const searchStartTime = Date.now();
    
    // 🚀 ПРОВЕРЯЕМ КЭШИ ДЛЯ МГНОВЕННЫХ РЕЗУЛЬТАТОВ!
    const cachedResults = this.getCachedResult(query, limit);
    if (cachedResults) {
      this.recordCacheHit();
      return cachedResults;
    }

    this.initializeFuse(mode);
    console.error(`🔍 Searching: "${query}" in ${this.indexData.length} notes [mode=${mode}]`);
    
    // 🔍 ПАРСИМ РАСШИРЕННЫЕ ОПЕРАТОРЫ!
    const parsedQuery = QueryParser.parse(query);
    const hasAdvancedOperators = parsedQuery.exactPhrases.length > 0 || 
                                 parsedQuery.requiredTerms.length > 0 || 
                                 parsedQuery.excludedTerms.length > 0 || 
                                 parsedQuery.fieldQueries.length > 0;

    if (hasAdvancedOperators) {
      console.error(`🔍 Advanced operators: phrases=${parsedQuery.exactPhrases.length}, required=${parsedQuery.requiredTerms.length}, excluded=${parsedQuery.excludedTerms.length}, fields=${parsedQuery.fieldQueries.length}`);
    }

    // Используем все термины для обычного поиска
    const searchTerms = [...parsedQuery.terms, ...parsedQuery.requiredTerms, ...parsedQuery.exactPhrases];
    const effectiveQuery = searchTerms.join(' ');

    let allResults: any[] = [];

    // 🔧 ИСПРАВЛЕНИЕ: Advanced-only запросы (только field/required/excluded/phrases) — используем весь индекс как кандидаты
    if (hasAdvancedOperators && searchTerms.length === 0) {
      console.error(`🔧 Advanced-only query: using full index as candidate set before advanced filtering`);
      allResults = this.indexData.map((note, index) => ({
        item: note,
        score: 0,
        refIndex: index
      }));
    } else {
      // Обычная логика поиска
      const expandedQueries = this.expandQueryWithSynonyms(effectiveQuery || query);
      
      // Выполняем поиск по всем вариантам запроса
      for (const searchQuery of expandedQueries) {
        const results = this.fuse.search(searchQuery);
        allResults.push(...results);
      }
    }

    // Убираем дубликаты и оставляем лучшие результаты
    const uniqueResults = new Map();
    for (const result of allResults) {
      const id = result.item.id;
      if (!uniqueResults.has(id) || result.score < uniqueResults.get(id).score) {
        uniqueResults.set(id, result);
      }
    }

    // 🎯 ФИНАЛЬНАЯ ФИЛЬТРАЦИЯ! Сбалансированный порог качества
    const MIN_SCORE_THRESHOLD = 0.35; // 🎯 ФИНАЛ: разумный баланс точности и полноты
    const qualitySortedResults = Array.from(uniqueResults.values())
      .filter((result: any) => {
        const score = result.score ?? 0; // 🔧 ИСПРАВЛЕНИЕ: обрабатываем undefined score как 0 (идеальный)
        return score < MIN_SCORE_THRESHOLD;
      })
      .sort((a: any, b: any) => (a.score ?? 0) - (b.score ?? 0)); // 🔧 ИСПРАВЛЕНИЕ: безопасная сортировка с undefined
    
    console.error(`🎯 Quality filter: ${qualitySortedResults.length}/${uniqueResults.size} results passed (threshold: ${MIN_SCORE_THRESHOLD})`);

    // Конвертируем в формат SearchResult
    // Для advanced-only запросов не ограничиваем до лимита до применения фильтров по полям
    const preLimitResults = (hasAdvancedOperators && searchTerms.length === 0)
      ? qualitySortedResults
      : qualitySortedResults.slice(0, limit);

    const searchResults: SearchResult[] = preLimitResults
      .map((result: any) => {
        const note = result.item as ObsidianNote;
        const score = result.score ?? 0; // 🔧 ИСПРАВЛЕНИЕ: безопасная обработка undefined score
        
        // Определяем тип совпадения и уверенность
        let type = 'fuse_match';
        let confidence = 'high';
        if (score > 0.3) confidence = 'medium'; // 🔧 ИСПРАВЛЕНИЕ: используем безопасный score
        if (score > 0.6) confidence = 'low';    // 🔧 ИСПРАВЛЕНИЕ: используем безопасный score

        // 🎯 HIGHLIGHTING И УМНОЕ ИЗВЛЕЧЕНИЕ КОНТЕКСТА!
        const originalContent = note.content || '';
        const normalizedQuery = this.normalizeQuery(query);
        const smartSnippet = this.extractRelevantSnippet(originalContent, normalizedQuery || query, 300);
        const highlightedSnippet = this.highlightMatches(smartSnippet, normalizedQuery || query);
        
        // Дополнительная семантическая корректировка (эвристика):
        let finalScore = score;
        if ((mode as any) === 'semantic') {
          const qWords = this.extractQueryWords(normalizedQuery || query);
          let matches = 0;
          const lc = (originalContent || '').toLowerCase();
          for (const w of qWords) {
            if (!w || w.length < 2) continue;
            const re = new RegExp(this.escapeRegex(w), 'g');
            const m = lc.match(re);
            if (m) matches += Math.min(5, m.length);
          }
          const sem = matches > 0 ? Math.min(0.25, 0.7 / (matches + 1)) : 0.7;
          finalScore = Math.min(score, sem);
          if (finalScore < score) confidence = 'high';
        }

        return {
          id: note.id || 'unknown',
          title: this.highlightMatches(note.title || 'Untitled', normalizedQuery || query), // 🎯 Highlighting в заголовке!
          description: this.highlightMatches(note.description || '', normalizedQuery || query), // 🎯 Highlighting в описании!
          path: note.path,
          lastModified: note.lastModified || '',
          score: finalScore,
          type,
          content_preview: highlightedSnippet, // 🎯 Умный snippet с highlighting!
          tags: note.tags,
          links: note.links,
          confidence
        };
      });

    console.error(`✨ Found ${searchResults.length} results with Fuse.js`);
    
    // 🔍 Применяем расширенные операторы поиска!
    let filteredResults = searchResults;
    if (hasAdvancedOperators) {
      filteredResults = this.filterByAdvancedQuery(searchResults, parsedQuery, this.indexData);
      console.error(`🔍 Advanced filtering: ${filteredResults.length}/${searchResults.length} results passed`);
    }

    // Теперь применяем лимит ТОЛЬКО после advanced-фильтрации для advanced-only запросов
    if (hasAdvancedOperators && searchTerms.length === 0) {
      filteredResults = filteredResults.slice(0, limit);
    }
    
    // 🔗 Добавляем связанные заметки к результатам!
    const enhancedResults = this.searchWithLinks(query, filteredResults, includeLinked);
    
    console.error(`🔗 Enhanced with linked notes: ${enhancedResults.length} total results (${enhancedResults.length - filteredResults.length} linked notes added)`);
    
    // 📊 Применяем категоризацию для лучшей организации!
    const categorized = this.categorizeResults(enhancedResults);
    const finalResults = this.formatCategorizedResults(categorized, limit);
    
    // Подсчитываем статистику по категориям
    const categoryStats: string[] = [];
    for (const [category, results] of categorized) {
      if (results.length > 0) {
        categoryStats.push(`${category}: ${results.length}`);
      }
    }
    
    console.error(`📊 Results categorized: ${finalResults.length} total results. Categories: ${categoryStats.join(', ')}`);
    
    // 🚀 СОХРАНЯЕМ В КЭШ ДЛЯ БУДУЩИХ ЗАПРОСОВ!
    this.setCachedResult(query, limit, finalResults);
    
    // 📊 ЗАПИСЫВАЕМ АНАЛИТИКУ ПОИСКА!
    const searchTime = Date.now() - searchStartTime;
    const linkedNotesCount = enhancedResults.length - filteredResults.length;
    this.recordSearchAnalytics(query, searchTime, finalResults.length, hasAdvancedOperators, linkedNotesCount, categorized);
    
    // Показываем статистику каждые 10 поисков
    if (this.searchStats.totalSearches % 10 === 0) {
      console.error(`\n${this.getSearchStatistics()}\n`);
    }
    
    return finalResults;
  }

  // Получаем заметку по ID для полного контента
  public getFullNoteContent(noteId: string): string | null {
    // Сначала пытаемся канонизировать (учитывая алиасы)
    let resolvedPath: string | undefined;
    try {
      const r = this.resolveNotePublic(noteId);
      if (r && r.exists && r.path) resolvedPath = r.path;
    } catch {}

    const note = resolvedPath
      ? this.indexData.find(n => n.path === resolvedPath) || this.getNote(noteId)
      : this.getNote(noteId);
    // Если нашли в индексе — читаем по fullPath
    if (note && note.fullPath) {
      try {
        const fullContent = readFileSync(note.fullPath, 'utf-8');
        console.error(`📄 Successfully read full content for indexed note: ${note.title} (${fullContent.length} chars)`);
        return fullContent;
      } catch (error) {
        console.error(`❌ Error reading indexed note ${noteId}:`, error);
        return note.content || note.content_preview || null;
      }
    }

    // 🔁 ФОЛЛБЭК: пробуем трактовать noteId как относительный путь в vault
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
    } catch (error) {
      console.error(`❌ Fallback read error for ${noteId}:`, error);
    }

    return null;
  }
  // ПУБЛИЧНЫЙ: безопасно записывает файл заметки в vault
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
    const {
      filePath,
      content,
      writeMode = 'create',
      frontmatter,
      heading,
      ensureMdExtension = true,
      createMissingFolders = true
    } = options;

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

    // Создаем директории при необходимости
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
      writeFileSync(absolutePath, finalContent, { encoding: 'utf-8' });
      // 🔄 Инкрементальная индексация
      try { this.scheduleIndexSingleFile(relWithExt); } catch {}
      return {
        absolutePath,
        relativePath: relWithExt,
        bytesWritten: Buffer.byteLength(finalContent, 'utf-8'),
        created: !fileExists,
        overwritten: fileExists,
        appended: false
      };
    }

    // append mode
    let bytesWritten = 0;
    if (!fileExists) {
      // Если файла нет, при append создаем новый с (опц.) frontmatter и контентом
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

    // Файл существует: читаем и дописываем
    const original = readFileSync(absolutePath, 'utf-8');
    let updated = original;
    if (heading && heading.trim().length > 0) {
      updated = this.appendUnderHeading(original, heading.trim(), content);
    } else {
      const needsNewline = !original.endsWith('\n');
      updated = original + (needsNewline ? '\n\n' : '\n') + content + '\n';
    }
    writeFileSync(absolutePath, updated, { encoding: 'utf-8' });
    bytesWritten = Buffer.byteLength(updated, 'utf-8') - Buffer.byteLength(original, 'utf-8');
    // 🔄 Инкрементальная индексация
    try { this.scheduleIndexSingleFile(relWithExt); } catch {}
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
    const yaml = Object.entries(frontmatter)
      .map(([key, value]) => {
        if (Array.isArray(value)) {
          return `${key}: [${value.map(v => JSON.stringify(v)).join(', ')}]`;
        }
        if (value && typeof value === 'object') {
          return `${key}: ${JSON.stringify(value)}`;
        }
        return `${key}: ${JSON.stringify(value)}`;
      })
      .join('\n');
    return `---\n${yaml}\n---\n\n${content}`;
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
    while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
    const before = lines.slice(0, insertAt).join('\n');
    const after = lines.slice(insertAt).join('\n');
    const middle = (before.endsWith('\n') ? '' : '\n') + '\n' + addition + '\n';
    return before + middle + (after ? '\n' + after : '');
  }

  private parseFrontmatterAndBody(original: string): { frontmatter: Record<string, any>, body: string } {
    const fmMatch = original.match(/^---\n([\s\S]*?)\n---\n?/);
    let body = original;
    const obj: Record<string, any> = {};
    if (fmMatch) {
      const fmText = fmMatch[1];
      body = original.slice(fmMatch[0].length);
      for (const line of fmText.split('\n')) {
        const m = line.match(/^([^:]+):\s*(.*)$/);
        if (m) {
          const key = m[1].trim();
          let val: any = m[2].trim();
          if (val.startsWith('[') || val.startsWith('{')) {
            try { val = JSON.parse(val); } catch {}
          } else if (/^".*"$/.test(val) || /^'.*'$/.test(val)) {
            val = val.slice(1, -1);
          }
          obj[key] = val;
        }
      }
    }
    return { frontmatter: obj, body };
  }

  // ПУБЛИЧНЫЙ: создать «нод» — заметку с frontmatter (id, type, props)
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
    if (title) fm.title = title;
    if (type) fm.type = type;
    return this.writeNote({ filePath, content, writeMode: 'create', frontmatter: fm, ensureMdExtension, createMissingFolders });
  }

  // ПУБЛИЧНЫЙ: создать связь A->B (и опц. B->A)
  public linkNotes(options: {
    fromPath: string;
    toPath: string;
    relation?: string; // имя свойства списка ссылок, например related/depends_on
    mode?: 'property' | 'body' | 'both';
    bidirectional?: boolean;
    heading?: string; // для body-режима
  }) {
    const { fromPath, toPath, relation = 'related', mode = 'both', bidirectional = true, heading = 'Relations' } = options;

    // Ссылка формата [[path]]
    const toWikilink = this.toWikiLink(toPath);
    const fromWikilink = this.toWikiLink(fromPath);

    const updates: Array<() => void> = [];

    if (mode === 'property' || mode === 'both') {
      updates.push(() => this.upsertLinkInFrontmatter(fromPath, relation, toWikilink));
      if (bidirectional) updates.push(() => this.upsertLinkInFrontmatter(toPath, relation, fromWikilink));
    }
    if (mode === 'body' || mode === 'both') {
      updates.push(() => this.appendRelationBody(fromPath, heading, toWikilink));
      if (bidirectional) updates.push(() => this.appendRelationBody(toPath, heading, fromWikilink));
    }

    for (const fn of updates) fn();

    return { ok: true, fromPath, toPath, relation, mode, bidirectional };
  }

  private toWikiLink(relPath: string): string {
    const withExt = relPath.toLowerCase().endsWith('.md') ? relPath : `${relPath}.md`;
    // Превращаем путь в название заметки без .md для wikilink
    const noteName = path.basename(withExt, '.md');
    return `[[${noteName}]]`;
  }

  private upsertLinkInFrontmatter(filePath: string, relation: string, wikilink: string): void {
    const vaultRoot = path.resolve(this.vaultPath);
    const relWithExt = filePath.toLowerCase().endsWith('.md') ? filePath : `${filePath}.md`;
    const absolutePath = path.resolve(vaultRoot, relWithExt.replace(/^\/+/, ''));
    if (!absolutePath.startsWith(vaultRoot)) throw new Error('Path escape detected');

    let original = '';
    if (existsSync(absolutePath)) {
      original = readFileSync(absolutePath, 'utf-8');
    } else {
      // создаём, если отсутствует
      writeFileSync(absolutePath, this.buildMarkdownWithFrontmatter({}, ''), { encoding: 'utf-8' });
      original = readFileSync(absolutePath, 'utf-8');
    }

    // Парсим frontmatter (простая стратегия)
    const { frontmatter: obj, body } = this.parseFrontmatterAndBody(original);

    // upsert в список ссылок
    const list = Array.isArray(obj[relation]) ? obj[relation] : (obj[relation] ? [obj[relation]] : []);
    if (!list.includes(wikilink)) list.push(wikilink);
    obj[relation] = list;

    const newContent = this.buildMarkdownWithFrontmatter(obj, body.trimStart());
    writeFileSync(absolutePath, newContent, { encoding: 'utf-8' });
    // 🔄 Инкрементальная индексация
    try { this.scheduleIndexSingleFile(relWithExt); } catch {}
  }

  private appendRelationBody(filePath: string, heading: string, wikilink: string): void {
    const vaultRoot = path.resolve(this.vaultPath);
    const relWithExt = filePath.toLowerCase().endsWith('.md') ? filePath : `${filePath}.md`;
    const absolutePath = path.resolve(vaultRoot, relWithExt.replace(/^\/+/, ''));
    if (!absolutePath.startsWith(vaultRoot)) throw new Error('Path escape detected');

    if (!existsSync(absolutePath)) {
      writeFileSync(absolutePath, `## ${heading}\n\n${wikilink}\n`, { encoding: 'utf-8' });
      // 🔄 Индексация новой записи
      try { this.scheduleIndexSingleFile(relWithExt); } catch {}
      return;
    }
    const original = readFileSync(absolutePath, 'utf-8');
    // Проверка на дубликаты внутри секции heading
    const lines = original.split('\n');
    const headingRegex = new RegExp(`^#{1,6}\\s+${this.escapeRegex(heading)}\\s*$`, 'i');
    const idx = lines.findIndex(line => headingRegex.test(line));
    if (idx !== -1) {
      let end = idx + 1;
      while (end < lines.length && !/^#{1,6}\s+/.test(lines[end])) end++;
      const section = lines.slice(idx + 1, end).join('\n');
      if (section.includes(wikilink)) {
        // Уже есть — ничего не делаем
        return;
      }
    }
    const updated = this.appendUnderHeading(original, heading, wikilink);
    writeFileSync(absolutePath, updated, { encoding: 'utf-8' });
    // 🔄 Инкрементальная индексация
    try { this.scheduleIndexSingleFile(relWithExt); } catch {}
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
    if (!absolutePath.startsWith(vaultRoot)) throw new Error('Path escape detected');

    if (createMissingFolders) {
      const dir = path.dirname(absolutePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    let original = existsSync(absolutePath) ? readFileSync(absolutePath, 'utf-8') : '';
    if (!original) original = this.buildMarkdownWithFrontmatter({}, '');

    const { frontmatter, body } = this.parseFrontmatterAndBody(original);
    if (set) {
      for (const [k, v] of Object.entries(set)) frontmatter[k] = v;
    }
    if (removeKeys) {
      for (const k of removeKeys) delete frontmatter[k];
    }
    const newContent = this.buildMarkdownWithFrontmatter(frontmatter, body.trimStart());
    writeFileSync(absolutePath, newContent, { encoding: 'utf-8' });
    // 🔄 Инкрементальная индексация
    try { this.scheduleIndexSingleFile(relWithExt); } catch {}
    return { absolutePath, relativePath: relWithExt };
  }

  // Находит заметки без базовой категоризации/фронтматтера
  public findUncategorizedNotes(options?: { limit?: number }): Array<{ path: string; title: string; reasons: string[] }> {
    const limit = options?.limit ?? 20;
    const results: Array<{ path: string; title: string; reasons: string[]; lastModified?: string }> = [];
    for (const n of this.indexData) {
      if (n.path.startsWith('.obsidian/') || n.path.includes('/node_modules/')) continue;
      const content = n.content || n.content_preview || '';
      const { frontmatter } = this.parseFrontmatterAndBody(content);
      const fm = frontmatter || {};
      const reasons: string[] = [];
      const title = (fm.title || n.title || (n.path.split('/').pop() || '').replace(/\.md$/i, '')) as string;
      const inCanon = n.path.startsWith('graph/Knowledge Hub/');

      // Базовые проблемы
      if (!fm || Object.keys(fm).length === 0) reasons.push('no-frontmatter');
      if (!fm.title) reasons.push('no-title');
      if (!fm.type) reasons.push('no-type');

      // Для листьев (type != class) ожидаем связь/Relations (taxonomy НЕ обязательна)
      const isClass = String(fm.type || '').toLowerCase() === 'class';
      if (!isClass) {
        const hasFmLink = Array.isArray(fm.part_of) ? fm.part_of.length > 0 : Boolean(fm.part_of);
        const hasBodyLink = /(^|\n)##\s+Relations\b[\s\S]*?\[\[.+?\]\]/i.test(content);
        if (!hasFmLink && !hasBodyLink) reasons.push('no-relations');
      }

      // Вне канон-папок — сигнал к миграции
      if (!inCanon) reasons.push('outside-canonical-folders');

      // Итог: считаем некатегоризованной, если есть серьёзные причины
      const serious = reasons.filter(r => ['no-frontmatter','no-type','no-title','outside-canonical-folders','no-relations'].includes(r));
      if (serious.length > 0) {
        // Классы считаем ок, если в каноне и есть title/type
        if (!(isClass && inCanon && !serious.some(r => r !== 'outside-canonical-folders'))) {
          results.push({ path: n.path, title, reasons: serious, lastModified: n.lastModified });
        }
      }
    }
    // Сортируем: сначала самые новые
    results.sort((a, b) => (new Date(b.lastModified || 0).getTime() - new Date(a.lastModified || 0).getTime()));
    return results.slice(0, limit).map(({ path, title, reasons }) => ({ path, title, reasons }));
  }

  // Грубая эвристика для определения типа ноды по содержимому
  private guessTypeByHeuristics(title: string, content: string): string {
    const t = `${title}\n${content}`.toLowerCase();
    if (/(обсидиан|templater|dataview|плагин|plugin)/i.test(t)) return 'tool';
    if (/(психоактив|лекарств|фармаколог|антидепресс|этанол|этиловый спирт|alcohol|ethanol)/i.test(t)) return 'drug';
    if (/(linux|bash|docker|git|http|api|node|typescript|python|regex)/i.test(t)) return 'technology';
    return 'note';
  }

  // Нормализация фронтматтера: baseline + заголовок + тип + теги
  public normalizeNoteBaseline(options: { filePath: string; dryRun?: boolean }): {
    path: string;
    updatedKeys: string[];
    guessed: { title?: string; type?: string; aliases?: string[]; tags?: string[]; taxonomy?: string[] };
  } {
    const { filePath, dryRun = false } = options;
    const vaultRoot = path.resolve(this.vaultPath);
    let relWithExt = filePath.toLowerCase().endsWith('.md') ? filePath : `${filePath}.md`;
    // Попытка прямого доступа
    let abs = path.resolve(vaultRoot, relWithExt.replace(/^\/+/, ''));
    if (!abs.startsWith(vaultRoot)) throw new Error('Path escape detected');
    // Если нет на диске — пробуем найти по индексу (учитываем кавычки/регистр)
    if (!existsSync(abs)) {
      const base = path.basename(relWithExt).toLowerCase();
      // Точный путь в индексе
      const byExact = this.indexData.find(n => (n.path || '').toLowerCase() === relWithExt.toLowerCase());
      // По basename
      const byBase = byExact || this.indexData.find(n => path.basename(n.path || '').toLowerCase() === base);
      // По title
      const titleNoExt = base.replace(/\.md$/i, '');
      const byTitle = byBase || this.indexData.find(n => (n.title || '').toLowerCase() === titleNoExt);
      if (byTitle) {
        relWithExt = byTitle.path;
        abs = path.resolve(vaultRoot, relWithExt.replace(/^\/+/, ''));
      }
    }
    if (!existsSync(abs)) throw new Error(`File not found: ${relWithExt}`);
    const original = readFileSync(abs, 'utf-8');
    const { frontmatter, body } = this.parseFrontmatterAndBody(original);
    const currentFm = frontmatter || {} as Record<string, any>;

    // Заголовок: из FM, из первого H1, иначе из имени файла
    let title = currentFm.title;
    if (!title) {
      const m = body.match(/^#\s+(.+)$/m);
      title = m ? m[1].trim() : path.basename(relWithExt, '.md');
    }
    // Тип
    let type = currentFm.type;
    if (!type) type = this.guessTypeByHeuristics(title as string, body);
    // Теги
    let tags: string[] = Array.isArray(currentFm.tags) ? currentFm.tags.slice() : (currentFm.tags ? [String(currentFm.tags)] : []);
    if (!tags.includes('autocaptured')) tags.push('autocaptured');
    // Алиасы
    let aliases: string[] = Array.isArray(currentFm.aliases) ? currentFm.aliases.slice() : (currentFm.aliases ? [String(currentFm.aliases)] : []);
    // Таксономия (не навязываем, оставляем пустой массив, чтобы связать позже)
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

    const updatedKeys = Object.keys(updated).filter(k => currentFm[k] !== updated[k]);
    if (!dryRun) {
      const newContent = this.buildMarkdownWithFrontmatter(updated, body.trimStart());
      writeFileSync(abs, newContent, { encoding: 'utf-8' });
      try { this.indexSingleFile(relWithExt); } catch {}
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
    const { fromPath, toPath, relation = 'related', mode = 'both', bidirectional = true, heading = 'Relations' } = options;
    const toWikilink = this.toWikiLink(toPath);
    const fromWikilink = this.toWikiLink(fromPath);

    const updates: Array<() => void> = [];
    if (mode === 'property' || mode === 'both') {
      updates.push(() => this.removeLinkFromFrontmatter(fromPath, relation, toWikilink));
      if (bidirectional) updates.push(() => this.removeLinkFromFrontmatter(toPath, relation, fromWikilink));
    }
    if (mode === 'body' || mode === 'both') {
      updates.push(() => this.removeRelationInBody(fromPath, heading, toWikilink));
      if (bidirectional) updates.push(() => this.removeRelationInBody(toPath, heading, fromWikilink));
    }
    for (const fn of updates) fn();
    return { ok: true };
  }

  private removeLinkFromFrontmatter(filePath: string, relation: string, wikilink: string): void {
    const vaultRoot = path.resolve(this.vaultPath);
    const relWithExt = filePath.toLowerCase().endsWith('.md') ? filePath : `${filePath}.md`;
    const absolutePath = path.resolve(vaultRoot, relWithExt.replace(/^\/+/, ''));
    if (!absolutePath.startsWith(vaultRoot)) throw new Error('Path escape detected');
    if (!existsSync(absolutePath)) return;
    const original = readFileSync(absolutePath, 'utf-8');
    const { frontmatter, body } = this.parseFrontmatterAndBody(original);
    if (frontmatter[relation]) {
      const arr = Array.isArray(frontmatter[relation]) ? frontmatter[relation] : [frontmatter[relation]];
      const filtered = arr.filter((x: any) => x !== wikilink);
      if (filtered.length === 0) delete frontmatter[relation]; else frontmatter[relation] = filtered;
      const newContent = this.buildMarkdownWithFrontmatter(frontmatter, body.trimStart());
      writeFileSync(absolutePath, newContent, { encoding: 'utf-8' });
      // 🔄 Инкрементальная индексация
      try { this.scheduleIndexSingleFile(relWithExt); } catch {}
    }
  }

  private removeRelationInBody(filePath: string, heading: string, wikilink: string): void {
    const vaultRoot = path.resolve(this.vaultPath);
    const relWithExt = filePath.toLowerCase().endsWith('.md') ? filePath : `${filePath}.md`;
    const absolutePath = path.resolve(vaultRoot, relWithExt.replace(/^\/+/, ''));
    if (!absolutePath.startsWith(vaultRoot)) throw new Error('Path escape detected');
    if (!existsSync(absolutePath)) return;
    const original = readFileSync(absolutePath, 'utf-8');
    const lines = original.split('\n');
    const headingRegex = new RegExp(`^#{1,6}\\s+${this.escapeRegex(heading)}\\s*$`, 'i');
    const idx = lines.findIndex(line => headingRegex.test(line));
    if (idx === -1) return;
    let end = idx + 1;
    while (end < lines.length && !/^#{1,6}\s+/.test(lines[end])) end++;
    const before = lines.slice(0, idx + 1);
    const section = lines.slice(idx + 1, end);
    const after = lines.slice(end);
    const filtered = section.filter(line => !line.includes(wikilink));
    const updated = [...before, ...filtered, ...after].join('\n');
    writeFileSync(absolutePath, updated, { encoding: 'utf-8' });
    // 🔄 Инкрементальная индексация
    try { this.scheduleIndexSingleFile(relWithExt); } catch {}
  }

  // ===== Helpers for graph/links =====
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
      if (raw) result.push(this.normalizeNoteKey(raw));
    }
    return [...new Set(result)];
  }

  private resolveNoteKeyToPath(key: string): string | null {
    const norm = this.normalizeNoteKey(key);
    // try exact path match
    const byPath = this.indexData.find(n => this.normalizeNoteKey(n.path) === norm);
    if (byPath) return byPath.path;
    // try title match
    const byTitle = this.indexData.find(n => this.normalizeNoteKey(n.title || '') === norm);
    if (byTitle) return byTitle.path;
    return null;
  }

  // removed private variant to avoid duplicate — public accessor added below

  private getOutgoingPaths(fromPath: string): string[] {
    const note = this.indexData.find(n => n.path === fromPath);
    if (!note) return [];
    const keys = this.extractWikiLinks((note.content || note.content_preview || ''));
    const paths = keys.map(k => this.resolveNoteKeyToPath(k)).filter((p): p is string => !!p);
    // also inspect frontmatter link-like arrays
    const { frontmatter } = this.parseFrontmatterAndBody(note.content || '');
    for (const [k, v] of Object.entries(frontmatter)) {
      if (Array.isArray(v)) {
        for (const item of v) {
          if (typeof item === 'string' && /\[\[[^\]]+\]\]/.test(item)) {
            const key = this.normalizeNoteKey(item.replace(/^\[\[|\]\]$/g, '').split('#')[0]);
            const p = this.resolveNoteKeyToPath(key);
            if (p) paths.push(p);
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
        if (!newIndex.has(tgt)) newIndex.set(tgt, new Set());
        newIndex.get(tgt)!.add(n.path);
      }
    }
    this.backlinkIndex = newIndex;
  }

  private getNote(noteId: string): ObsidianNote | null {
    return this.indexData.find(note => 
      note.id === noteId || 
      note.path === noteId || 
      note.title === noteId
    ) || null;
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

  // Попытка загрузить пользовательские синонимы из заметок vault
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
          } catch {}
        }
        const lines = content.split('\n');
        for (const line of lines) {
          const m = line.match(/^\s*([^:#]+)\s*:\s*([^#]+)$/);
          if (!m) continue;
          const key = m[1].trim().toLowerCase();
          const vals = m[2].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
          if (key && vals.length > 0) {
            merged[key] = [...new Set([...(merged[key] || []), ...vals])];
          }
        }
      }
      return merged;
    } catch {
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

  // Expose safe accessors for server usage
  public getNotePathFromId(noteId: string): string | null {
    const note = this.indexData.find(n => n.id === noteId || n.path === noteId || (n.title && n.title === noteId));
    if (note) return note.path;
    return this.resolveNoteKeyToPath(noteId);
  }

  public getOutgoingPathsPub(pathInput: string): string[] { return this.getOutgoingPaths(pathInput); }
  public getBacklinkPathsPub(pathInput: string): string[] { return this.getBacklinkPaths(pathInput); }
  public getIndexData(): ObsidianNote[] { return this.indexData; }
  public getVaultRoot(): string { return this.vaultPath; }
  public reindexFileIncremental(relPath: string): void { this.indexSingleFile(relPath); }

  // ===== Graph repair and utilities =====
  private getCanonicalHubPath(): string {
    return 'graph/Knowledge Hub/Knowledge Hub.md';
  }

  private ensurePartOf(fromPath: string, toPath: string): void {
    const vaultRoot = path.resolve(this.vaultPath);
    const fromRel = fromPath.toLowerCase().endsWith('.md') ? fromPath : `${fromPath}.md`;
    const fromAbs = path.resolve(vaultRoot, fromRel.replace(/^\/+/, ''));
    if (!existsSync(fromAbs)) return; // avoid resurrecting deleted files
    const toWikilink = this.toWikiLink(toPath);
    // frontmatter
    this.upsertLinkInFrontmatter(fromPath, 'part_of', toWikilink);
    // body
    this.appendRelationBody(fromPath, 'Relations', toWikilink);
  }

  private removeRelatedToHubIfNotHub(filePath: string): void {
    const vaultRoot = path.resolve(this.vaultPath);
    const rel = filePath.toLowerCase().endsWith('.md') ? filePath : `${filePath}.md`;
    const abs = path.resolve(vaultRoot, rel.replace(/^\/+/, ''));
    if (!existsSync(abs)) return; // do not touch non-existing
    const hub = this.getCanonicalHubPath().replace(/\.md$/i, '');
    const hubWiki = this.toWikiLink(hub);
    if (rel === this.getCanonicalHubPath()) return;
    // remove from frontmatter related
    this.removeLinkFromFrontmatter(rel, 'related', hubWiki);
    // remove from body under Relations
    this.removeRelationInBody(rel, 'Relations', hubWiki);
  }

  private parentIndexPathOf(notePath: string): string | null {
    // notePath expected with .md, under graph/Knowledge Hub/...
    const parts = notePath.replace(/\\/g, '/').split('/');
    if (parts.length < 3) return null;
    // remove filename
    parts.pop();
    if (parts.length === 0) return null;
    const currentFolder = parts[parts.length - 1];
    // parent folder
    if (parts.length < 2) return null;
    const parentFolder = parts[parts.length - 2];
    const parentPath = [...parts.slice(0, parts.length - 1), `${parentFolder}.md`].join('/');
    return parentPath;
  }

  private ensureIndexNoteExists(indexPath: string): void {
    const vaultRoot = path.resolve(this.vaultPath);
    const abs = path.resolve(vaultRoot, indexPath);
    const dir = path.dirname(abs);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(abs)) {
      const title = path.basename(indexPath, '.md');
      const content = `## Summary\nИндекс‑заметка раздела «${title}».\n\n## Relations\n`;
      const fm = { title, type: 'class' } as Record<string, any>;
      const md = this.buildMarkdownWithFrontmatter(fm, content);
      writeFileSync(abs, md, { encoding: 'utf-8' });
      try { this.scheduleIndexSingleFile(indexPath); } catch {}
    }
  }

  public repairGraph(): { fixed: number } {
    let fixed = 0;
    const hub = this.getCanonicalHubPath();
    const vaultRoot = path.resolve(this.vaultPath);
    const notes = this.indexData.map(n => n.path).filter(p => p.startsWith('graph/Knowledge Hub/') && p.endsWith('.md'));
    for (const p of notes) {
      if (p === hub) continue;
      const abs = path.resolve(vaultRoot, p);
      if (!existsSync(abs)) continue; // skip phantom paths
      // Remove direct related to hub for non-hub
      this.removeRelatedToHubIfNotHub(p);

      // Ensure chain upwards via folder hierarchy
      let current = p;
      while (true) {
        const parent = this.parentIndexPathOf(current);
        if (!parent) break;
        // Ensure parent index note exists
        this.ensureIndexNoteExists(parent);
        // Ensure part_of link current -> parent
        this.ensurePartOf(current, parent);
        fixed++;
        if (parent === hub) break;
        current = parent;
      }
    }
    return { fixed };
  }

  // ===== Simple template engine =====
  public applyTemplate(options: { template: string; variables?: Record<string, any>; filePath?: string; writeMode?: 'create'|'overwrite'|'append'; heading?: string }): { content: string; writtenPath?: string } {
    const { template, variables = {}, filePath, writeMode = 'create', heading } = options;
    const rendered = template.replace(/{{\s*([a-zA-Z0-9_\.]+)\s*}}/g, (_m, key) => {
      if (key === 'date') return new Date().toISOString().slice(0, 10);
      if (key === 'datetime') return new Date().toISOString();
      const parts = String(key).split('.');
      let val: any = variables as any;
      for (const part of parts) { if (val && Object.prototype.hasOwnProperty.call(val, part)) val = val[part]; else { val = ''; break; } }
      return String(val ?? '');
    });
    if (filePath) {
      const res = this.writeNote({ filePath, content: rendered, writeMode, heading });
      return { content: rendered, writtenPath: res.relativePath };
    }
    return { content: rendered };
  }

  // ===== Bulk autolink =====
  public bulkAutolink(options: { mappings: { term: string; toPath: string }[]; maxPerFile?: number; limitFiles?: number }): { updatedFiles: number } {
    const { mappings, maxPerFile = 3, limitFiles = 50 } = options;
    let updatedFiles = 0;
    const vaultRoot = path.resolve(this.vaultPath);
    const processed = new Set<string>();
    for (const n of this.indexData) {
      if (processed.size >= limitFiles) break;
      if (!n.path.endsWith('.md')) continue;
      if (n.path.startsWith('.obsidian/') || n.path.includes('/node_modules/')) continue;
      const abs = path.resolve(vaultRoot, n.path);
      if (!existsSync(abs)) continue;
      let text = readFileSync(abs, 'utf-8');
      let hits = 0;
      for (const { term, toPath } of mappings) {
        const noteName = path.basename((toPath.toLowerCase().endsWith('.md')? toPath : `${toPath}.md`), '.md');
        const re = new RegExp(`(?<!\\[\\[])(${this.escapeRegex(term)})`, 'gi');
        const before = text;
        text = text.replace(re, (m) => {
          if (hits >= maxPerFile) return m;
          hits++;
          return `[[${noteName}]]`;
        });
        if (text !== before && hits >= maxPerFile) break;
      }
      if (hits > 0) {
        writeFileSync(abs, text, { encoding: 'utf-8' });
        try { this.indexSingleFile(n.path); } catch {}
        updatedFiles++;
        processed.add(n.path);
      }
    }
    return { updatedFiles };
  }

  // ===== Note move/clone =====
  public moveNote(options: { fromPath: string; toPath: string; overwrite?: boolean }): { from: string; to: string } {
    const { fromPath, toPath, overwrite = false } = options;
    const vaultRoot = path.resolve(this.vaultPath);
    const fromRel = fromPath.toLowerCase().endsWith('.md') ? fromPath : `${fromPath}.md`;
    const toRel = toPath.toLowerCase().endsWith('.md') ? toPath : `${toPath}.md`;
    const fromAbs = path.resolve(vaultRoot, fromRel);
    const toAbs = path.resolve(vaultRoot, toRel);
    const toDir = path.dirname(toAbs);
    if (!existsSync(fromAbs)) throw new Error(`Source not found: ${fromRel}`);
    if (existsSync(toAbs) && !overwrite) throw new Error(`Target exists: ${toRel}`);
    if (!existsSync(toDir)) mkdirSync(toDir, { recursive: true });
    const data = readFileSync(fromAbs, 'utf-8');
    writeFileSync(toAbs, data, { encoding: 'utf-8' });
    // remove original
    rmSync(fromAbs);
    try { this.scheduleIndexSingleFile(toRel); } catch {}
    return { from: fromRel, to: toRel };
  }

  public cloneNote(options: { fromPath: string; toPath: string; setTitle?: string }): { from: string; to: string } {
    const { fromPath, toPath, setTitle } = options;
    const vaultRoot = path.resolve(this.vaultPath);
    const fromRel = fromPath.toLowerCase().endsWith('.md') ? fromPath : `${fromPath}.md`;
    const toRel = toPath.toLowerCase().endsWith('.md') ? toPath : `${toPath}.md`;
    const fromAbs = path.resolve(vaultRoot, fromRel);
    const toAbs = path.resolve(vaultRoot, toRel);
    const toDir = path.dirname(toAbs);
    if (!existsSync(fromAbs)) throw new Error(`Source not found: ${fromRel}`);
    if (!existsSync(toDir)) mkdirSync(toDir, { recursive: true });
    let data = readFileSync(fromAbs, 'utf-8');
    if (setTitle) {
      const parsed = this.parseFrontmatterAndBody(data);
      parsed.frontmatter.title = setTitle;
      data = this.buildMarkdownWithFrontmatter(parsed.frontmatter, parsed.body);
    }
    writeFileSync(toAbs, data, { encoding: 'utf-8' });
    try { this.scheduleIndexSingleFile(toRel); } catch {}
    return { from: fromRel, to: toRel };
  }

  // ===== Note delete =====
  public deleteNote(options: { path: string }): { deletedPath: string } {
    const { path: relInput } = options;
    const vaultRoot = path.resolve(this.vaultPath);
    const rel = relInput.toLowerCase().endsWith('.md') ? relInput : `${relInput}.md`;
    const abs = path.resolve(vaultRoot, rel.replace(/^\/+/, ''));
    if (!abs.startsWith(vaultRoot)) throw new Error('Path escape detected');
    if (existsSync(abs)) {
      rmSync(abs);
    }
    return { deletedPath: rel };
  }

  // ===== Capture & Journal =====
  private sanitizeName(name: string): string {
    return (name || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  public captureNote(options: { name: string; content: string; tags?: string[]; relations?: string[]; folder?: string; linkToHub?: boolean; hubs?: string[] }): { path: string } {
    const { name, content, tags = [], relations = [], folder = 'inbox', linkToHub = true, hubs = [] } = options;
    if (!name || !content) throw new Error('name and content are required');
    const safeName = this.sanitizeName(name) || 'note';
    const relBase = `${folder.replace(/^\/+|\/+$/g,'')}/${safeName}.md`;
    const fmTags = Array.from(new Set([...(tags || []).map(t=>String(t)), 'autocaptured']));
    const fm: Record<string, any> = { title: safeName, type: 'note', tags: fmTags };
    // prepare related wikilinks for frontmatter
    const relatedLinks: string[] = [];
    const addLink = (to: string) => {
      const rr = this.resolveNotePublic(to);
      const toPath = (rr && rr.exists && rr.path) ? rr.path : to;
      const wl = this.toWikiLink(toPath);
      if (!relatedLinks.includes(wl)) relatedLinks.push(wl);
    };
    for (const r of relations) addLink(r);
    if (Array.isArray(hubs) && hubs.length > 0) {
      for (const h of hubs) addLink(h);
    } else if (linkToHub) {
      const hub = this.getCanonicalHubPath().replace(/\.md$/i,'');
      const wl = `[[${path.basename(hub,'.md')}]]`;
      if (!relatedLinks.includes(wl)) relatedLinks.push(wl);
    }
    if (relatedLinks.length) fm['related'] = relatedLinks;

    const res = this.writeNote({ filePath: relBase, content, writeMode: 'create', frontmatter: fm, ensureMdExtension: true, createMissingFolders: true });

    // also add body Relations section links (no duplicates via appendRelationBody guard)
    if (Array.isArray(hubs) && hubs.length > 0) {
      for (const h of hubs) {
        const rr = this.resolveNotePublic(h);
        const toPath = (rr && rr.exists && rr.path) ? rr.path : h;
        this.appendRelationBody(res.relativePath, 'Relations', this.toWikiLink(toPath));
      }
    } else if (linkToHub) {
      this.appendRelationBody(res.relativePath, 'Relations', this.toWikiLink(this.getCanonicalHubPath()));
    }
    for (const r of relations) {
      const rr = this.resolveNotePublic(r);
      const toPath = (rr && rr.exists && rr.path) ? rr.path : r;
      this.appendRelationBody(res.relativePath, 'Relations', this.toWikiLink(toPath));
    }

    return { path: res.relativePath };
  }

  public dailyJournalAppend(options: { content: string; heading?: string; bullet?: boolean; timestamp?: boolean; filePath?: string; date?: string }): { path: string } {
    const { content, heading = 'Inbox', bullet = true, timestamp = true, filePath, date } = options;
    if (!content) throw new Error('content is required');
    const day = (date && /\d{4}-\d{2}-\d{2}/.test(date)) ? date : new Date().toISOString().slice(0,10);
    const rel = filePath ? filePath : `inbox/${day}.md`;
    this.writeNote({ filePath: rel, content, writeMode: 'append', heading, ensureMdExtension: true, createMissingFolders: true });
    return { path: rel.endsWith('.md') ? rel : `${rel}.md` };
  }

  // ====== New helpers for navigation & graph ======

  // Resolve note by input (id|path|title|alias). Returns canonical info.
  public resolveNotePublic(input: string): { path?: string; id?: string; title?: string; aliases?: string[]; exists: boolean; suggestions: string[] } {
    if (!input) return { exists: false, suggestions: [] } as any;
    // Try direct match by id|path|title
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
    // Try resolve by normalized key from wikilink semantics
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
    // Suggestions: fuzzy by title/path basename
    const key = this.normalizeNoteKey(input);
    const variants: string[] = [];
    for (const n of this.indexData) {
      const base = this.normalizeNoteKey(n.title || path.basename(n.path, '.md'));
      if (base.includes(key) || key.includes(base)) {
        variants.push(n.path);
        if (variants.length >= 10) break;
      }
    }
    return { exists: false, suggestions: variants } as any;
  }

  // Extract frontmatter link-like arrays as relations: key -> list of target paths.
  private listFrontmatterLinks(note: ObsidianNote): Record<string, string[]> {
    const res: Record<string, string[]> = {};
    try {
      const { frontmatter } = this.parseFrontmatterAndBody(note.content || '');
      for (const [k, v] of Object.entries(frontmatter || {})) {
        const pushResolved = (val: string) => {
          // Expect wikilink [[...]]; extract inner
          const m = val.match(/\[\[([^\]]+)\]\]/);
          if (!m) return;
          const key = this.normalizeNoteKey(m[1].split('#')[0]);
          const p = this.resolveNoteKeyToPath(key);
          if (!p) return;
          if (!res[k]) res[k] = [];
          if (!res[k].includes(p)) res[k].push(p);
        };
        if (Array.isArray(v)) {
          for (const item of v) if (typeof item === 'string') pushResolved(item);
        } else if (typeof v === 'string') {
          pushResolved(v);
        }
      }
    } catch {}
    return res;
  }

  // Build vault tree from indexData paths
  public buildVaultTree(options: { root?: string; maxDepth?: number; includeFiles?: boolean; includeCounts?: boolean; sort?: 'name'|'mtime'|'count'; limitPerDir?: number }): any {
    const cacheKey = this.heavyKey('get-vault-tree', options);
    const cached = this.heavyGet(cacheKey);
    if (cached) return cached;
    const rootPrefix = (options.root || '').replace(/^\/+|\/+$/g, '');
    const maxDepth = Math.max(1, Math.min(10, options.maxDepth ?? 3));
    const includeFiles = options.includeFiles ?? false;
    const includeCounts = options.includeCounts ?? true;
    const sort = (options.sort || 'name') as 'name'|'mtime'|'count';
    const limitPerDir = options.limitPerDir ?? 50;

    type DirNode = { name: string; path: string; type: 'directory'; children: (DirNode|any)[]; counts: { files: number; md_files: number }; mtimeLatest?: string };

    const root: DirNode = { name: rootPrefix || '/', path: rootPrefix || '/', type: 'directory', children: [], counts: { files: 0, md_files: 0 }, mtimeLatest: undefined };
    const dirMap = new Map<string, DirNode>();
    dirMap.set(rootPrefix || '/', root);

    const consider = (p: string) => rootPrefix ? p.startsWith(rootPrefix + '/') || p === rootPrefix : true;

    // Build directories
    for (const n of this.indexData) {
      const p = n.path || '';
      if (!p.toLowerCase().endsWith('.md')) continue;
      if (!consider(p)) continue;
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

    // Attach child dirs
    for (const [key, node] of dirMap.entries()) {
      if (key === (rootPrefix || '/')) continue;
      const parent = key.includes('/') ? key.substring(0, key.lastIndexOf('/')) : (rootPrefix || '/');
      const parentNode = dirMap.get(parent) || root;
      if (!parentNode.children.includes(node)) parentNode.children.push(node);
    }

    // Fill files and counts
    for (const n of this.indexData) {
      const p = n.path || '';
      if (!consider(p)) continue;
      const md = p.toLowerCase().endsWith('.md');
      const dir = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : (rootPrefix || '/');
      const dirNode = dirMap.get(dir) || root;
      dirNode.counts.files++;
      if (md) dirNode.counts.md_files++;
      const lm = n.lastModified ? new Date(n.lastModified).toISOString() : undefined;
      if (lm) {
        if (!dirNode.mtimeLatest || lm > dirNode.mtimeLatest) dirNode.mtimeLatest = lm;
      }
      if (includeFiles) {
        const file = { name: path.basename(p), path: p, type: 'file', mtime: n.lastModified || '', md: md };
        dirNode.children.push(file);
      }
    }

    // Sorting and limiting
    const sorter = (a: any, b: any) => {
      if (a.type === 'file' && b.type === 'directory') return 1;
      if (a.type === 'directory' && b.type === 'file') return -1;
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'count') return (b.counts?.md_files || 0) - (a.counts?.md_files || 0);
      if (sort === 'mtime') return (b.mtimeLatest || b.mtime || '').localeCompare(a.mtimeLatest || a.mtime || '');
      return 0;
    };

    const walkSortLimit = (node: DirNode, depth: number) => {
      node.children.sort(sorter);
      if (limitPerDir && node.children.length > limitPerDir) node.children = node.children.slice(0, limitPerDir);
      if (depth >= maxDepth) {
        // cut deeper directories
        node.children = node.children.filter(c => c.type !== 'directory');
        return;
      }
      for (const c of node.children) if (c.type === 'directory') walkSortLimit(c, depth + 1);
    };
    walkSortLimit(root, 0);

    if (!includeCounts) {
      const stripCounts = (node: DirNode) => {
        delete (node as any).counts;
        for (const c of node.children) if (c.type === 'directory') stripCounts(c);
      };
      stripCounts(root);
    }

    this.heavySet(cacheKey, root);
    return root;
  }

  // Get folder contents with degrees, filters, sorting
  public buildFolderContents(options: { folderPath: string; recursive?: boolean; sortBy?: 'name'|'mtime'|'degreeIn'|'degreeOut'; limit?: number; filter?: { ext?: string[]; type?: string; tagIncludes?: string[] } }): any[] {
    const cacheKey = this.heavyKey('get-folder-contents', options);
    const cached = this.heavyGet(cacheKey);
    if (cached) return cached;
    const folder = options.folderPath.replace(/^\/+|\/+$/g, '');
    const recursive = options.recursive ?? false;
    const sortBy = (options.sortBy || 'mtime') as 'name'|'mtime'|'degreeIn'|'degreeOut';
    const limit = options.limit ?? 200;
    const exts = options.filter?.ext;
    const typeFilter = options.filter?.type;
    const tagIncludes = options.filter?.tagIncludes || [];

    const isDirectChild = (p: string) => {
      if (!p.startsWith(folder + '/')) return false;
      const rest = p.substring(folder.length + 1);
      return !rest.includes('/');
    };

    const pick = (n: ObsidianNote) => {
      const p = n.path || '';
      if (folder && !(recursive ? p.startsWith(folder + '/') : isDirectChild(p))) return false;
      if (exts && exts.length > 0 && !exts.some(e => p.toLowerCase().endsWith(e.toLowerCase()))) return false;
      if (typeFilter && String(n.type || '').toLowerCase() !== String(typeFilter).toLowerCase()) return false;
      if (tagIncludes.length > 0) {
        const tags = (n.tags || []).map(t => String(t).toLowerCase());
        if (!tagIncludes.every(t => tags.includes(String(t).toLowerCase()))) return false;
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
      if (sortBy === 'name') return a.title.localeCompare(b.title);
      if (sortBy === 'mtime') return (b.mtime || '').localeCompare(a.mtime || '');
      if (sortBy === 'degreeIn') return b.degreeIn - a.degreeIn;
      if (sortBy === 'degreeOut') return b.degreeOut - a.degreeOut;
      return 0;
    });

    const out = rows.slice(0, limit);
    this.heavySet(cacheKey, out);
    return out;
  }

  // Collect edges from a note based on body wikilinks and frontmatter lists
  private collectNoteEdges(note: ObsidianNote, includeBody: boolean, includeFM: boolean): { target: string; relation: string }[] {
    const edges: { target: string; relation: string }[] = [];
    if (includeBody) {
      const keys = this.extractWikiLinks(note.content || note.content_preview || '') || [];
      for (const key of keys) {
        const p = this.resolveNoteKeyToPath(key);
        if (p) edges.push({ target: p, relation: 'wikilink' });
      }
    }
    if (includeFM) {
      const fm = this.listFrontmatterLinks(note);
      for (const [k, arr] of Object.entries(fm)) {
        for (const p of arr) edges.push({ target: p, relation: `frontmatter:${k}` });
      }
    }
    return edges;
  }

  private buildEgoGraph(startPath: string, depth: number, direction: 'in'|'out'|'both', includeBody: boolean, includeFM: boolean, maxNodes: number, maxEdges: number) {
    const nodes = new Map<string, ObsidianNote>();
    const edges: { source: string; target: string; relation: string }[] = [];
    const q: { path: string; d: number }[] = [];
    const seen = new Set<string>();

    const pushNode = (p: string) => {
      if (nodes.size >= maxNodes) return false;
      const n = this.indexData.find(x => x.path === p);
      if (!n) return false;
      nodes.set(p, n);
      return true;
    };

    if (!pushNode(startPath)) return { nodes, edges };
    q.push({ path: startPath, d: 0 });
    seen.add(startPath);

    while (q.length > 0) {
      const { path: p, d } = q.shift()!;
      if (d >= depth) continue;

      const addEdge = (src: string, dst: string, relation: string) => {
        if (edges.length >= maxEdges) return;
        edges.push({ source: src, target: dst, relation });
      };

      if (direction === 'out' || direction === 'both') {
        const srcNote = this.indexData.find(x => x.path === p);
        if (srcNote) {
          for (const e of this.collectNoteEdges(srcNote, includeBody, includeFM)) {
            if (pushNode(e.target)) {}
            addEdge(p, e.target, e.relation);
            if (!seen.has(e.target)) { seen.add(e.target); q.push({ path: e.target, d: d + 1 }); }
          }
        }
      }

      if (direction === 'in' || direction === 'both') {
        // incoming: any n that links to p
        for (const n of this.indexData) {
          if (nodes.size >= maxNodes) break;
          const outs = this.collectNoteEdges(n, includeBody, includeFM).filter(e => e.target === p);
          if (outs.length > 0) {
            if (pushNode(n.path)) {}
            for (const e of outs) addEdge(n.path, p, e.relation);
            if (!seen.has(n.path)) { seen.add(n.path); q.push({ path: n.path, d: d + 1 }); }
          }
        }
      }

      if (nodes.size >= maxNodes || edges.length >= maxEdges) break;
    }
    return { nodes, edges };
  }

  private buildFolderSubgraph(prefix: string, includeBody: boolean, includeFM: boolean, maxNodes: number, maxEdges: number) {
    const set = new Set<string>(this.indexData.filter(n => n.path.startsWith(prefix + '/') || n.path === prefix).map(n => n.path));
    const nodes = new Map<string, ObsidianNote>();
    for (const p of set) {
      if (nodes.size >= maxNodes) break;
      const n = this.indexData.find(x => x.path === p);
      if (n) nodes.set(p, n);
    }
    const edges: { source: string; target: string; relation: string }[] = [];
    for (const n of nodes.values()) {
      for (const e of this.collectNoteEdges(n, includeBody, includeFM)) {
        if (edges.length >= maxEdges) break;
        if (set.has(e.target)) edges.push({ source: n.path, target: e.target, relation: e.relation });
      }
      if (edges.length >= maxEdges) break;
    }
    return { nodes, edges };
  }

  private formatGraphMermaid(nodes: Map<string, ObsidianNote>, edges: { source: string; target: string; relation: string }[]) {
    const ids = new Map<string, string>();
    let idx = 0;
    for (const p of nodes.keys()) ids.set(p, `n${idx++}`);
    const esc = (s: string) => s.replace(/"/g, '\\"');
    const lines = [ 'graph TD' ];
    for (const [p, n] of nodes.entries()) {
      lines.push(`  ${ids.get(p)}["${esc(n.title || path.basename(p, '.md'))}"]`);
    }
    for (const e of edges) {
      const a = ids.get(e.source), b = ids.get(e.target);
      if (a && b) lines.push(`  ${a} --> ${b}`);
    }
    return lines.join('\n');
  }

  private formatGraphDot(nodes: Map<string, ObsidianNote>, edges: { source: string; target: string; relation: string }[]) {
    const esc = (s: string) => s.replace(/"/g, '\\"');
    const lines = [ 'digraph G {'];
    for (const n of nodes.values()) {
      lines.push(`  "${esc(n.path)}" [label="${esc(n.title || path.basename(n.path, '.md'))}"];`);
    }
    for (const e of edges) lines.push(`  "${esc(e.source)}" -> "${esc(e.target)}";`);
    lines.push('}');
    return lines.join('\n');
  }

  // Public: build graph snapshot based on args
  public getGraphSnapshot(args: { scope?: { startNoteId?: string; folderPrefix?: string }; depth?: number; direction?: 'in'|'out'|'both'; include?: { bodyLinks?: boolean; fmLinks?: boolean }; maxNodes?: number; maxEdges?: number; annotate?: boolean; format?: 'json'|'mermaid'|'dot'|'text'; allowedRelations?: string[]; nodeFilter?: { pathPrefix?: string; tagIncludes?: string[] } }) {
    const cacheKey = this.heavyKey('get-graph-snapshot', args);
    const cached = this.heavyGet(cacheKey);
    if (cached) return cached;
    const depth = Math.max(1, Math.min(3, args.depth ?? 2));
    const direction = (args.direction || 'both') as 'in'|'out'|'both';
    const includeBody = args.include?.bodyLinks ?? true;
    const includeFM = args.include?.fmLinks ?? true;
    const maxNodes = args.maxNodes ?? 300;
    const maxEdges = args.maxEdges ?? 1000;
    const annotate = args.annotate ?? true;
    const scope = args.scope || {};

    let nodes: Map<string, ObsidianNote>, edgeArr: { source:string; target:string; relation:string }[];
    const allowSet = (args.allowedRelations && args.allowedRelations.length > 0) ? new Set(args.allowedRelations) : null;
    if (scope.startNoteId) {
      const resolved = this.resolveNotePublic(scope.startNoteId);
      if (!resolved.exists || !resolved.path) return { nodes: [], edges: [] };
      const res = this.buildEgoGraph(resolved.path, depth, direction, includeBody, includeFM, maxNodes, maxEdges);
      nodes = res.nodes; edgeArr = allowSet ? res.edges.filter(e => allowSet.has(e.relation)) : res.edges;
    } else if (scope.folderPrefix) {
      const res = this.buildFolderSubgraph(scope.folderPrefix.replace(/^\/+|\/+$/g,'').trim(), includeBody, includeFM, maxNodes, maxEdges);
      nodes = res.nodes; edgeArr = res.edges;
    } else {
      return { nodes: [], edges: [] };
    }

    // Deduplicate edges for rendering and aggregation
    const pairKey = (e: {source:string;target:string;relation:string}) => `${e.source}__${e.target}`;
    const edgeAgg = new Map<string, Record<string, number>>();
    for (const e of edgeArr) {
      const k = pairKey(e);
      if (!edgeAgg.has(k)) edgeAgg.set(k, {});
      const rels = edgeAgg.get(k)!;
      rels[e.relation] = (rels[e.relation] || 0) + 1;
    }
    let dedupEdges = Array.from(edgeAgg.keys()).map(k => {
      const [source, target] = k.split('__');
      return { source, target, relation: 'any' } as {source:string;target:string;relation:string};
    });

    // Optional node filter (path prefix / tag includes)
    const nf = args.nodeFilter || {};
    if (nf.pathPrefix || (nf.tagIncludes && nf.tagIncludes.length)) {
      const keep = new Set<string>();
      const tagSet = (arr: string[]|undefined) => new Set((arr||[]).map(t=>String(t).toLowerCase()));
      const needTags = new Set((nf.tagIncludes||[]).map(t=>String(t).toLowerCase()));
      const hasAll = (ts: Set<string>) => Array.from(needTags).every(t=>ts.has(t));
      for (const [p, n] of nodes.entries()) {
        const okPrefix = nf.pathPrefix ? p.startsWith(nf.pathPrefix) : true;
        const okTags = needTags.size ? hasAll(tagSet(n.tags)) : true;
        if (okPrefix && okTags) keep.add(p);
      }
      // Filter nodes and edges accordingly
      const filteredNodes = new Map<string, ObsidianNote>();
      for (const p of keep) { const n = nodes.get(p); if (n) filteredNodes.set(p, n); }
      const filteredEdges = dedupEdges.filter(e => keep.has(e.source) && keep.has(e.target));
      nodes = filteredNodes; // reassign
      // Update dedupEdges reference
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
    const out = { nodes: outNodes, edges: dedupEdges, edgesAggregated: Array.from(edgeAgg.entries()).map(([k,v])=>({ pair:k, relations:v })), truncated: truncated ? { nodesReturned: outNodes.length, edgesReturned: dedupEdges.length, maxNodes, maxEdges } : undefined };
    if (args.format === 'text') {
      const top = [...outNodes].sort((a,b)=> (b.degIn+b.degOut)-(a.degIn+a.degOut)).slice(0,10);
      const lines = [
        `Nodes: ${outNodes.length}, Edges: ${dedupEdges.length}`,
        truncated ? `NOTE: truncated (maxNodes=${maxNodes}, maxEdges=${maxEdges})` : undefined,
        `Top hubs:`,
        ...top.map(t => `- ${t.title} (${t.path}) deg=${t.degIn+t.degOut}`)
      ].filter(Boolean) as string[];
      const text = lines.join('\n');
      this.heavySet(cacheKey, text);
      return text;
    }
    this.heavySet(cacheKey, out);
    return out;
  }

  // Public: neighborhood
  public getNoteNeighborhood(args: { noteId: string; depth?: number; fanoutLimit?: number; direction?: 'in'|'out'|'both'; format?: 'text'|'json' }) {
    const cacheKey = this.heavyKey('get-note-neighborhood', args);
    const cached = this.heavyGet(cacheKey);
    if (cached) return cached;
    const depth = Math.max(1, Math.min(3, args.depth ?? 2));
    const direction = (args.direction || 'both') as 'in'|'out'|'both';
    const fanout = args.fanoutLimit ?? 30;
    const resolved = this.resolveNotePublic(args.noteId);
    if (!resolved.exists || !resolved.path) return args.format === 'json' ? { levels: [] } : `Not found: ${args.noteId}`;

    const root = resolved.path;
    const levels: string[][] = [];
    let frontier = [root];
    const visited = new Set<string>([root]);

    for (let d=0; d<depth; d++) {
      const next: string[] = [];
      const layer: string[] = [];
      for (const p of frontier) {
        let outs: string[] = [];
        let ins: string[] = [];
        if (direction === 'out' || direction === 'both') outs = this.getOutgoingPathsPub(p).slice(0, fanout);
        if (direction === 'in' || direction === 'both') ins = this.getBacklinkPathsPub(p).slice(0, fanout);
        for (const q of [...outs, ...ins]) if (!visited.has(q)) { visited.add(q); layer.push(q); next.push(q); }
      }
      levels.push(layer);
      frontier = next;
      if (levels.flat().length >= 300) break;
    }

    const truncated = levels.flat().length >= 300;
    if (args.format === 'json') {
      const out = { levels, truncated };
      this.heavySet(cacheKey, out);
      return out;
    }
    const lines: string[] = [`Root: ${root}`];
    levels.forEach((layer,i)=> {
      lines.push(`L${i+1}:`);
      for (const p of layer) {
        const n = this.indexData.find(x => x.path === p);
        lines.push(`- ${p} (${n?.title || ''})`);
      }
    });
    if (truncated) lines.push(`(truncated)`);
    const text = lines.join('\n');
    this.heavySet(cacheKey, text);
    return text;
  }

  // Public: list relations of a note
  public getRelationsOfNote(args: { noteId: string; include?: { bodyLinks?: boolean; frontmatterLists?: string[]|'*' } }) {
    const includeBody = args.include?.bodyLinks ?? true;
    const fmSel = args.include?.frontmatterLists;
    const resolved = this.resolveNotePublic(args.noteId);
    if (!resolved.exists || !resolved.path) return { wikilinks: [], frontmatter: {} };
    const n = this.indexData.find(x => x.path === resolved.path)!;
    const wikilinks: string[] = [];
    if (includeBody) {
      for (const key of this.extractWikiLinks(n.content || n.content_preview || '')) {
        const p = this.resolveNoteKeyToPath(key);
        if (p && !wikilinks.includes(p)) wikilinks.push(p);
      }
    }
    const fmAll = this.listFrontmatterLinks(n);
    const fm: Record<string,string[]> = {};
    if (fmSel === '*' || fmSel == null) Object.assign(fm, fmAll);
    else for (const k of fmSel) if (fmAll[k]) fm[k] = fmAll[k];
    return { wikilinks, frontmatter: fm };
  }

  // Public: shortest path between two notes (BFS)
  public findPathBetween(args: { from: string; to: string; direction?: 'in'|'out'|'both'; maxDepth?: number; allowedRelations?: string[]; format?: 'text'|'json'|'mermaid' }) {
    const direction = (args.direction || 'both') as 'in'|'out'|'both';
    const maxDepth = Math.max(1, Math.min(6, args.maxDepth ?? 5));
    const allow = args.allowedRelations && args.allowedRelations.length > 0 ? new Set(args.allowedRelations) : null;
    const a = this.resolveNotePublic(args.from), b = this.resolveNotePublic(args.to);
    if (!a.exists || !a.path || !b.exists || !b.path) return args.format==='json'?{ paths:[] }: `Not found: ${args.from} or ${args.to}`;
    if (a.path === b.path) return args.format==='json'?{ paths:[[a.path]] }: `${a.path}`;

    const prev = new Map<string, { prev: string; relation: string }>();
    const q: string[] = [a.path];
    const dist = new Map<string, number>();
    dist.set(a.path, 0);

    while (q.length > 0) {
      const cur = q.shift()!;
      const d = dist.get(cur)!;
      if (d >= maxDepth) continue;

      const expandFrom = (src: string) => {
        const note = this.indexData.find(x => x.path === src);
        if (!note) return [] as { target:string; relation:string }[];
        return this.collectNoteEdges(note, true, true).filter(e => !allow || allow.has(e.relation));
      };

      // Outgoing
      if (direction === 'out' || direction === 'both') {
        for (const e of expandFrom(cur)) {
          if (!dist.has(e.target)) { dist.set(e.target, d+1); prev.set(e.target, { prev: cur, relation: e.relation }); q.push(e.target); }
          if (e.target === b.path) { q.length = 0; break; }
        }
      }
      // Incoming
      if (direction === 'in' || direction === 'both') {
        for (const n of this.indexData) {
          for (const e of this.collectNoteEdges(n, true, true)) {
            if (e.target !== cur) continue;
            const tgt = n.path;
            if (allow && !allow.has(e.relation)) continue;
            if (!dist.has(tgt)) { dist.set(tgt, d+1); prev.set(tgt, { prev: cur, relation: e.relation }); q.push(tgt); }
            if (tgt === b.path) { q.length = 0; break; }
          }
        }
      }
    }

    if (!prev.has(b.path)) return args.format==='json'?{ paths:[] }: 'No path within maxDepth';
    const pathNodes: string[] = [];
    let cur = b.path;
    while (cur && cur !== a.path) { pathNodes.push(cur); cur = prev.get(cur)!.prev; }
    pathNodes.push(a.path);
    pathNodes.reverse();

    if (args.format === 'json') return { paths: [pathNodes] };
    if (args.format === 'mermaid') {
      const esc = (s:string)=>s.replace(/"/g,'\\"');
      const lines = ['graph TD'];
      for (let i=0;i<pathNodes.length;i++) {
        const p = pathNodes[i];
        const n = this.indexData.find(x=>x.path===p);
        lines.push(`  n${i}["${esc(n?.title||path.basename(p,'.md'))}"]`);
        if (i>0) lines.push(`  n${i-1} --> n${i}`);
      }
      return lines.join('\n');
    }
    return pathNodes.join(' -> ');
  }

  // ===== Семантический слой (скелет) =====
  private embedTextHash(text: string): number[] {
    const dim = 32;
    const vec = new Array(dim).fill(0);
    const lc = (text || '').toLowerCase();
    for (let i = 0; i < lc.length; i++) {
      const code = lc.charCodeAt(i);
      // учитывать буквы/цифры
      if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57) || (code >= 1072 && code <= 1103)) {
        vec[code % dim] += 1;
      }
    }
    // нормализация
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
    for (let i = 0; i < dim; i++) vec[i] = vec[i] / norm;
    return vec;
  }

  private ensureVector(notePath: string): number[] {
    // build or return cached vector for note
    const p = notePath.toLowerCase().endsWith('.md') ? notePath : `${notePath}.md`;
    const cached = this.embedStore.get(p);
    if (cached) return cached;
    const n = this.indexData.find(x => x.path === p);
    const text = n ? (n.content || n.content_preview || '') : '';
    const v = this.embedGenerate(text);
    this.embedStore.set(p, v);
    this.embedDirty = true;
    return v;
  }

  private scheduleEmbedUpdate(relPathInput: string): void {
    if (!this.embedPersist && !this.semanticEnabled) return;
    const rel = relPathInput.toLowerCase().endsWith('.md') ? relPathInput : `${relPathInput}.md`;
    this.embedPending.add(rel);
    if (this.embedUpdateTimer) return;
    this.embedUpdateTimer = setTimeout(() => {
      try {
        for (const p of Array.from(this.embedPending)) {
          try { this.ensureVector(p); } catch {}
          this.embedPending.delete(p);
        }
        this.saveEmbedStoreToDiskDebounced();
      } finally {
        if (this.embedUpdateTimer) { clearTimeout(this.embedUpdateTimer); this.embedUpdateTimer = null; }
      }
    }, 700);
  }

  private loadEmbedStoreFromDisk(): void {
    if (!this.embedPersist) return;
    try {
      if (!existsSync(this.embedStorePath)) return;
      const raw = JSON.parse(readFileSync(this.embedStorePath, 'utf-8')) as { vectors: Record<string, number[]> };
      const map = raw?.vectors || {};
      let loaded = 0;
      for (const [k, v] of Object.entries(map)) {
        if (Array.isArray(v) && v.length > 0) { this.embedStore.set(k, v); loaded++; }
      }
      console.error(`💾 Semantic store loaded: ${loaded} vectors from ${this.embedStorePath}`);
    } catch (e) {
      console.error('⚠️ Failed to load semantic store:', e);
    }
  }

  private saveEmbedStoreToDiskDebounced(): void {
    if (!this.embedPersist) return;
    if (!this.embedDirty) return; // nothing to save
    if (this.embedSaveTimer) clearTimeout(this.embedSaveTimer);
    this.embedSaveTimer = setTimeout(() => {
      try {
        const dir = path.dirname(this.embedStorePath);
        try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); } catch {}
        // backup existing
        if (this.embedBackup && existsSync(this.embedStorePath)) {
          try {
            const bak = this.embedStorePath + '.bak';
            const old = readFileSync(this.embedStorePath, 'utf-8');
            writeFileSync(bak, old, { encoding: 'utf-8' });
          } catch {}
        }
        const obj: Record<string, number[]> = {};
        for (const [k, v] of this.embedStore.entries()) obj[k] = v;
        const payload = JSON.stringify({ vectors: obj }, null, 2);
        writeFileSync(this.embedStorePath, payload, { encoding: 'utf-8' });
        this.embedDirty = false;
        console.error(`💾 Semantic store saved (${this.embedStore.size} vectors)`);
      } catch (e) {
        console.error('⚠️ Failed to save semantic store:', e);
      } finally {
        this.embedSaveTimer = null;
      }
    }, 500);
  }

  private textRelevanceScore(n: ObsidianNote, query: string): number {
    const words = Array.from(new Set(this.extractQueryWords(query).filter(w => w && w.length >= 2)));
    if (words.length === 0) return 0;
    const lc = (s: string) => (s || '').toLowerCase();
    const content = lc(n.content || n.content_preview || '');
    const title = lc(n.title || '');
    const pth = lc(n.path || '');

    let cHits=0, tHits=0, pHits=0;
    for (const w of words) {
      const ww = lc(w);
      if (content.includes(ww)) cHits++;
      if (title.includes(ww)) tHits++;
      if (pth.includes(ww)) pHits++;
    }
    const cFrac = cHits / words.length;
    const tFrac = tHits / words.length;
    const pFrac = pHits / words.length;

    const few = words.length <= 2;
    const wC = few ? 0.45 : 0.6;
    const wT = few ? 0.35 : 0.25;
    const wP = few ? 0.20 : 0.15;

    let score = wC * cFrac + wT * tFrac + wP * pFrac;

    // Бонус за точную фразу
    const phrase = lc(query).trim();
    if (phrase) {
      if (title.includes(phrase)) score = Math.min(1, score + (few ? 0.20 : 0.12));
      if (content.includes(phrase)) score = Math.min(1, score + (few ? 0.12 : 0.10));
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
    } catch (e) {
      this.embedProvider = 'hash';
      this.embedXenovaPipeline = null;
      console.error('⚠️ Xenova init failed, fallback to hash:', e?.toString?.() || e);
    }
  }

  private embedGenerate(text: string): number[] {
    if (this.embedProvider === 'xenova' && this.embedXenovaPipeline) {
      // попытка синхронной выборки: у pipeline API асинхронный вызов, но мы не хотим менять сигнатуры
      // Поэтому ограниченно используем hash, а для Xenova доверимся ensureVector, когда pipeline инициализируется
      // (реальный Xenova вызов будет применяться при последующих вызовах ensureVector/semanticQuery в фоне)
      // Здесь возвращаем hash, чтобы сигнатуры оставались sync.
      try { /* no-op */ } catch {}
    }
    return this.embedTextHash(text);
  }

  public embedAndUpsert(args: { noteId: string; mode?: 'note'|'chunks' }) {
    const r = this.resolveNotePublic(args.noteId);
    if (!r.exists || !r.path) return { ok: false, reason: 'not-found', semantic: this.semanticEnabled };
    const v = this.ensureVector(r.path);
    this.saveEmbedStoreToDiskDebounced();
    return { ok: true, path: r.path, dims: v.length, semantic: this.semanticEnabled };
  }

  public semanticQuery(args: { query: string; topK?: number; offset?: number; filters?: { pathPrefix?: string; tagIncludes?: string[]; type?: string } }) {
    const topK = Math.max(1, Math.min(50, args.topK ?? 5));
    const offset = Math.max(0, Math.min(10000, args.offset ?? 0));
    const query = String(args.query || '');
    const filters = args.filters || {};

    const cacheKey = this.heavyKey('semantic-query', { query, topK, offset, filters, alpha: this.SEM_ALPHA });
    const cached = this.heavyGet(cacheKey);
    if (cached) return cached;

    if (!this.semanticEnabled) {
      // мягкий фолбэк — обычный поиск и компактный вывод
      const results = this.searchNotes(query, topK, { mode: 'balanced', includeLinked: false });
      const out = results.map(r => ({ path: r.path, title: r.title.replace(/\*\*/g,''), score: r.score, source: 'fallback' }));
      this.heavySet(cacheKey, out);
      return out;
    }

    const qv = this.embedGenerate(query);
    const consider = (n: ObsidianNote) => {
      if (filters.pathPrefix && !n.path.startsWith(filters.pathPrefix)) return false;
      if (filters.tagIncludes && filters.tagIncludes.length > 0) {
        const tags = (n.tags || []).map(t => String(t).toLowerCase());
        for (const t of filters.tagIncludes) if (!tags.includes(String(t).toLowerCase())) return false;
      }
      if (filters.type) {
        const want = String(filters.type).toLowerCase();
        if (String(n.type || '').toLowerCase() !== want) return false;
      }
      return true;
    };

    const scored: { path: string; title: string; score: number; snippet: string }[] = [];
    let scanned = 0;
    const fewWords = this.extractQueryWords(query).filter(w=>w && w.length>=2).length <= 2;
    const localAlpha = fewWords ? Math.min(0.6, this.SEM_ALPHA) : this.SEM_ALPHA;
    const minLen = this.SEM_MINLEN_QUERY;
    const snipLen = fewWords ? Math.max(120, this.SNIPPET_LEN - 40) : this.SNIPPET_LEN;
    for (const n of this.indexData) {
      if (!consider(n)) continue;
      const len = (n.content || n.content_preview || '').length;
      if (len < minLen) continue;
      scanned++;
      if (scanned > this.SEM_MAX_SCAN) break;
      const v = this.ensureVector(n.path);
      // косинусная близость ~ dot (нормы уже 1)
      let dot = 0;
      for (let i = 0; i < Math.min(v.length, qv.length); i++) dot += v[i] * qv[i];
      // текстовая релевантность по словам (динамическая вейтовка происходит внутри)
      const textRel = this.textRelevanceScore(n, query);
      const finalScore = localAlpha * dot + (1 - localAlpha) * textRel;
      const snippet = this.extractRelevantSnippet(n.content || '', query, snipLen);
      scored.push({ path: n.path, title: n.title || path.basename(n.path, '.md'), score: finalScore, snippet });
    }
    scored.sort((a,b) => b.score - a.score);
    const out = scored.slice(offset, offset + topK);
    this.heavySet(cacheKey, out);
    return out;
  }
  public semanticBuildIndex(args: { limit?: number }) {
    const t0 = Date.now();
    let count = 0;
    let skipped = 0;
    let sumLen = 0;
    const byType: Record<string, number> = {};
    const limit = Math.max(0, args.limit ?? 0);
    const minLen = (()=>{ const v = parseInt(process.env.MCP_SEMANTIC_MINLEN || '80', 10); return Number.isFinite(v) && v>=0 ? v : 80; })();
    for (const n of this.indexData) {
      const len = (n.content || n.content_preview || '').length;
      if (len < minLen) { skipped++; continue; }
      this.ensureVector(n.path);
      count++;
      sumLen += len;
      const tp = String(n.type || 'note').toLowerCase();
      byType[tp] = (byType[tp] || 0) + 1;
      if (limit && count >= limit) break;
    }
    const ms = Date.now() - t0;
    const avgLen = count ? Math.round(sumLen / count) : 0;
    this.saveEmbedStoreToDiskDebounced();
    return { ok: true, count, skipped, ms, avgLen, byType, minLenFilter: minLen, semantic: this.semanticEnabled };
  }
}

// Создаем и экспортируем функцию для создания MCP сервера
export function createServer() {
  console.error("🚀 Creating new ObsidianMCPServer instance");
  console.error("🎯 PRODUCTION SEARCH CONFIGURATION:");
  console.error(`   📊 Default limit: ${DEFAULT_LIMIT} results (increased by user request)`);
  console.error(`   🔍 Fuse.js threshold: 0.25 (balanced strictness)`);
  console.error(`   🎯 Quality threshold: 0.35 (good balance)`);
  console.error(`   🔗 Linked notes: max 1 per result, only for score < 0.2`);
  console.error(`   📝 Min match length: 3 characters`);
  console.error(`   📚 Categories: shown in descriptions, clean format`);
  
  // Используем Singleton pattern для избежания множественных экземпляров
  if (!serverInstance) {
    serverInstance = new ObsidianMCPServer();
    serverInstance.loadIndexSync(); // Загружаем индекс при создании
  } else {
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
          name: "capture-note",
          description: `📝 Быстро создать заметку в inbox с фронтматтером и автолинком к Knowledge Hub.\n\nПараметры: name, content, tags[], relations[], folder (default: inbox), linkToHub (default: true), hubs[] (доп. хабы).`,
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string" },
              content: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              relations: { type: "array", items: { type: "string" } },
              folder: { type: "string", default: "inbox" },
              linkToHub: { type: "boolean", default: true },
              hubs: { type: "array", items: { type: "string" }, description: "Автолинк к указанным хабам (title|path). Если задан — linkToHub игнорируется." }
            },
            required: ["name","content"]
          }
        },
        {
          name: "daily-journal-append",
          description: `🗒️ Ежедневная запись: дописать в файл за YYYY-MM-DD под заданным заголовком (по умолчанию Inbox), с bullet+timestamp по умолчанию.`,
          inputSchema: {
            type: "object",
            properties: {
              content: { type: "string" },
              heading: { type: "string", default: "Inbox" },
              bullet: { type: "boolean", default: true },
              timestamp: { type: "boolean", default: true },
              filePath: { type: "string", description: "Переопределить путь файла (по умолчанию inbox/YYYY-MM-DD.md)" },
              date: { type: "string", description: "YYYY-MM-DD" }
            },
            required: ["content"]
          }
        },
        {
          name: "search-notes",
          description: `🔍 ИДЕАЛЬНЫЙ ПОИСК по заметкам Obsidian, оптимизированный для LLM-агентов.

Назначение: находить заметки по смыслу, поддерживать расширенные операторы и возвращать читаемый список.

🎯 HIGHLIGHTING — найденные слова подсвечиваются жирным **текстом**
🔗 Связанные заметки — автоматическое расширение хороших результатов  
🔍 Расширенные операторы:
  • "точная фраза" — поиск точного совпадения
  • +обязательное — слово должно присутствовать
  • -исключить — слово не должно встречаться
  • title:заголовок, path:путь, tags:тег, content:содержимое

Категоризация: результаты помечаются типами (📚 Документация, 📋 ТЗ, 💻 Код, 🎓 Обучение, ✅ TODO и др.)

Кэш: мгновенные повторные запросы. Fuzzy-поиск устойчив к опечаткам. Ведётся аналитика.

Советы для агента:
- Комбинируй запросы с полями (title/path/tags) для точности.
- Если используешь только поля — добавь одно-два общих термина.
- Начинай с общего запроса и при необходимости уточняй.

Примеры:
- javascript код
- "техническое задание" +gambit -старый  
- title:readme path:docs
- функция массив база

Поиск работает на русском и английском; доступны синонимы.`,
          inputSchema: {
            type: "object",
            properties: {
              libraryName: {
                type: "string",
                description: "Поисковый запрос для поиска в заметках Obsidian. Поддерживает расширенные операторы: \"точная фраза\", +обязательное, -исключить, field:value"
              }
            },
            required: ["libraryName"]
          }
        },
        {
          name: "find-uncategorized-notes",
          description: `🧹 Найти заметки без базовой категоризации (нет фронтматтера/title/type/taxonomy/relations или вне канон-папок).`,
          inputSchema: {
            type: "object",
            properties: { limit: { type: "number", description: "Максимум результатов", default: 20 } }
          }
        },
        {
          name: "normalize-note-baseline",
          description: `🧰 Привести заметку к базовому шаблону (frontmatter: title/type/tags/aliases/taxonomy). Не создаёт связи.`,
          inputSchema: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "Путь к заметке" },
              dryRun: { type: "boolean", description: "Только показать, что будет изменено", default: false }
            },
            required: ["filePath"]
          }
        },
        {
          name: "get-note-content",
          description: `📄 Получить ПОЛНОЕ СОДЕРЖИМОЕ заметки по её ID, пути или заголовку.

Назначение: когда нужен полный контент или извлечение секций по теме.

Советы для агента:
- context7CompatibleLibraryID — это ID/путь/заголовок из search-notes.
- tokens ограничивает примерный размер (≈4 символа = 1 токен).
- topic добавит релевантные секции в начало ответа.`,
          inputSchema: {
            type: "object", 
            properties: {
              context7CompatibleLibraryID: {
                type: "string",
                description: "ID заметки, путь к файлу или заголовок заметки для получения полного содержимого"
              },
              tokens: {
                type: "number",
                description: "Максимальное количество токенов содержимого для возврата (опционально, по умолчанию полное содержимое)"
              },
              topic: {
                type: "string", 
                description: "Опциональная тема для фокусировки на определенной части содержимого заметки"
              }
            },
            required: ["context7CompatibleLibraryID"]
          }
        },
        {
          name: "write-note",
          description: `✍️ Создать/перезаписать/дописать заметку (LLM-safe API).

Режимы:
- create — создать (ошибка, если файл существует)
- overwrite — перезаписать целиком (передавай итоговый текст)
- append — дописать в конец или под heading

Frontmatter: можно передать объект ключ-значение (Yaml/JSON сериализуется автоматически).

Рекомендации:
- Для append укажи heading, чтобы структурировать добавления.
- Для overwrite присылай полный финальный текст.

Примеры путей: "inbox/today" или "документация/new-note.md"` ,
          inputSchema: {
            type: "object",
            properties: {
              filePath: {
                type: "string",
                description: "Относительный путь в vault (с .md или без)"
              },
              content: {
                type: "string",
                description: "Markdown-содержимое для записи"
              },
              writeMode: {
                type: "string",
                enum: ["create", "overwrite", "append"],
                description: "Режим записи"
              },
              heading: {
                type: "string",
                description: "Если указан, при append допишет под этим заголовком (создаст при отсутствии)"
              },
              frontmatter: {
                type: "object",
                description: "Опциональный YAML frontmatter (ключ-значение)"
              },
              ensureMdExtension: {
                type: "boolean",
                description: "Добавить .md, если отсутствует",
                default: true
              },
              createMissingFolders: {
                type: "boolean",
                description: "Создавать недостающие папки",
                default: true
              }
            },
            required: ["filePath", "content"]
          }
        },
        {
          name: "append-under-heading",
          description: `➕ Точное дописывание под указанным заголовком.

Опции:
- Автосоздание заголовка, если он отсутствует
- Автопрефикс времени (ISO)
- Буллеты для списков

Советы:
- Для логов задач ставь bullet=true и timestamp=true.
- Пиши атомарные короткие записи.`,
          inputSchema: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "Путь к заметке (относительно vault)" },
              heading: { type: "string", description: "Заголовок, под которым нужно дописать" },
              content: { type: "string", description: "Текст для дописывания" },
              bullet: { type: "boolean", description: "Добавить '-' перед строкой", default: false },
              timestamp: { type: "boolean", description: "Добавить ISO-время перед строкой", default: false },
              ensureMdExtension: { type: "boolean", default: true },
              createMissingFolders: { type: "boolean", default: true }
            },
            required: ["filePath", "heading", "content"]
          }
        },
        {
          name: "create-node",
          description: `📦 Создать «ноду» — заметку с frontmatter (title, type, properties) и контентом.

Назначение: формирование вершин графа знаний. Свойства читаются Dataview/Graph.
Рекомендации: задавай говорящие title/type. В properties можно передавать массивы и объекты.`,
          inputSchema: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "Путь для новой заметки" },
              title: { type: "string", description: "Заголовок (frontmatter.title)" },
              type: { type: "string", description: "Тип ноды (frontmatter.type)" },
              properties: { type: "object", description: "Доп. свойства фронтматтера" },
              content: { type: "string", description: "Начальный контент" },
              ensureMdExtension: { type: "boolean", default: true },
              createMissingFolders: { type: "boolean", default: true }
            },
            required: ["filePath"]
          }
        },
        {
          name: "link-notes",
          description: `🔗 Связать две заметки (A→B), с опцией двунаправленной связи.

Режимы:
- property — добавить wikilink в список frontmatter (relation, по умолчанию related)
- body — дописать wikilink под заголовком (heading, по умолчанию Relations)
- both — записать и туда, и туда

Лучшие практики:
- Для зависимостей используй relation="depends_on".
- Для навигации — relation="related".
- bidirectional=true обычно полезно`,
          inputSchema: {
            type: "object",
            properties: {
              fromPath: { type: "string", description: "Относительный путь A" },
              toPath: { type: "string", description: "Относительный путь B" },
              relation: { type: "string", description: "Имя свойства-списка ссылок", default: "related" },
              mode: { type: "string", enum: ["property", "body", "both"], default: "both" },
              bidirectional: { type: "boolean", default: true },
              heading: { type: "string", description: "Заголовок для body-режима", default: "Relations" }
            },
            required: ["fromPath", "toPath"]
          }
        },
        {
          name: "upsert-frontmatter",
          description: `🧩 Безопасно обновить фронтматтер: set/remove ключи.

Советы: ссылки передавай как wikilink-строки "[[Note]]" или списки таких строк.`,
          inputSchema: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "Путь к заметке" },
              set: { type: "object", description: "Ключи/значения для установки" },
              removeKeys: { type: "array", items: { type: "string" }, description: "Ключи для удаления" },
              ensureMdExtension: { type: "boolean", default: true },
              createMissingFolders: { type: "boolean", default: true }
            },
            required: ["filePath"]
          }
        },
        {
          name: "unlink-notes",
          description: `🗑️ Удалить связь между двумя заметками. Работает симметрично при bidirectional=true.

Режимы: property | body | both. Для body укажи heading, если секций несколько.`,
          inputSchema: {
            type: "object",
            properties: {
              fromPath: { type: "string", description: "Путь A" },
              toPath: { type: "string", description: "Путь B" },
              relation: { type: "string", description: "Имя свойства (для property)", default: "related" },
              mode: { type: "string", enum: ["property", "body", "both"], default: "both" },
              bidirectional: { type: "boolean", default: true },
              heading: { type: "string", description: "Заголовок для body", default: "Relations" }
            },
            required: ["fromPath", "toPath"]
          }
        },
        {
          name: "repair-graph",
          description: `🧹 Привести граф в порядок по правилу «ёлки».

Действия:
- Удаляет прямые связи листьев с Knowledge Hub
- Гарантирует цепочки part_of по иерархии папок (child → parent)
- Автосоздаёт индекс‑заметки классов при отсутствии
Возвращает количество исправленных связей/узлов.`,
          inputSchema: { type: "object", properties: {}, additionalProperties: false }
        },
        {
          name: "apply-template",
          description: `🧩 Применить простой шаблон {{var}} к содержимому и (опционально) записать в файл.

Переменные: передаются объектом variables; доступны {{date}} и {{datetime}}.
Если передан filePath — результат будет записан указанным режимом.`,
          inputSchema: {
            type: "object",
            properties: {
              template: { type: "string", description: "Текст шаблона с плейсхолдерами {{var}}" },
              variables: { type: "object", description: "Объект переменных" },
              filePath: { type: "string", description: "Куда записать результат (опционально)" },
              writeMode: { type: "string", enum: ["create","overwrite","append"] },
              heading: { type: "string", description: "Заголовок для append" }
            },
            required: ["template"]
          }
        },
        {
          name: "bulk-autolink",
          description: `🔗 Массовая автолинковка: заменить в тексте упоминания на [[Note]].

Параметры: mappings[{term,toPath}], maxPerFile, limitFiles.`,
          inputSchema: {
            type: "object",
            properties: {
              mappings: { type: "array", items: { type: "object", properties: { term: { type: "string" }, toPath: { type: "string" } }, required: ["term","toPath"] } },
              maxPerFile: { type: "number", default: 3 },
              limitFiles: { type: "number", default: 50 }
            },
            required: ["mappings"]
          }
        },
        {
          name: "note-move",
          description: `📦 Переместить заметку в новое место (с созданием папок).`,
          inputSchema: { type: "object", properties: { fromPath: { type: "string" }, toPath: { type: "string" }, overwrite: { type: "boolean" } }, required: ["fromPath","toPath"] }
        },
        {
          name: "note-clone",
          description: `📄 Клонировать заметку в новый путь (опц. сменить title).`,
          inputSchema: { type: "object", properties: { fromPath: { type: "string" }, toPath: { type: "string" }, setTitle: { type: "string" } }, required: ["fromPath","toPath"] }
        },
        {
          name: "note-delete",
          description: `🗑️ Удалить заметку по пути (осторожно, безвозвратно).`,
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
        },
        {
          name: "reindex-vault",
          description: `🔄 Проиндексировать все заметки во vault и обновить поисковый индекс (Fuse.js).

Используй после массовых изменений/создания заметок. Возвращает количество заново проиндексированных заметок.`,
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false
          }
        },
        {
          name: "get-graph-summary",
          description: `📊 Получить сводку графа по заметке: исходящие/входящие связи, с глубиной.

Параметры: noteId, depth (1..3), direction (in|out|both), relation(optional для фильтрации).`,
          inputSchema: {
            type: "object",
            properties: {
              noteId: { type: "string", description: "ID/путь/заголовок заметки" },
              depth: { type: "number", description: "Глубина обхода", default: 1 },
              direction: { type: "string", enum: ["in", "out", "both"], default: "both" },
              relation: { type: "string", description: "Имя свойства для фильтрации (optional)" }
            },
            required: ["noteId"]
          }
        },
        {
          name: "find-unlinked-mentions",
          description: `🧠 Найти нелинкованные упоминания терминов и предложить автолинки.`,
          inputSchema: {
            type: "object",
            properties: {
              terms: { type: "array", items: { type: "string" }, description: "Список терминов/названий" },
              maxPerFile: { type: "number", default: 3 },
              limitFiles: { type: "number", default: 30 }
            },
            required: ["terms"]
          }
        },
        {
          name: "reindex-changed-since",
          description: `⏱️ Переиндексировать только изменённые со времени timestamp (ISO).`,
          inputSchema: {
            type: "object",
            properties: {
              since: { type: "string", description: "ISO-время" }
            },
            required: ["since"]
          }
        },
        {
          name: "embed-and-upsert",
          description: `🧠 СЕМАНТИКА: создать/обновить эмбеддинг заметки (каркас).\n\nЕсли семантика отключена, вернёт noop-ответ.`,
          inputSchema: {
            type: "object",
            properties: {
              noteId: { type: "string", description: "ID/путь/заголовок заметки" },
              mode: { type: "string", enum: ["note","chunks"], default: "note" }
            },
            required: ["noteId"]
          }
        },
        {
          name: "semantic-query",
          description: `🧠 СЕМАНТИКА: поиск по эмбеддингам (каркас).\n\nЕсли семантика отключена — мягкий фолбэк к обычному поиску.`,
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              topK: { type: "number", default: 5 },
              offset: { type: "number", default: 0 },
              filters: { type: "object", properties: { pathPrefix: { type: "string" }, tagIncludes: { type: "array", items: { type: "string" } }, type: { type: "string" } } }
            },
            required: ["query"]
          }
        },
        {
          name: "semantic-build-index",
          description: `🧠 СЕМАНТИКА: предрасчёт эмбеддингов для всех заметок (каркас).`,
          inputSchema: {
            type: "object",
            properties: { limit: { type: "number", description: "Ограничить кол-во" } }
          }
        },
        {
          name: "resolve-note",
          description: `🔎 Канонизация идентификатора заметки: title|alias|path → {path,id,title,aliases,exists,suggestions}`,
          inputSchema: {
            type: "object",
            properties: { input: { type: "string", description: "Заголовок/алиас/путь" } },
            required: ["input"]
          }
        },
        {
          name: "get-relations-of-note",
          description: `🕸️ Извлечь связи заметки: тела (wikilinks) и frontmatter-списки` ,
          inputSchema: {
            type: "object",
            properties: {
              noteId: { type: "string" },
              include: { type: "object", properties: { bodyLinks: { type: "boolean" }, frontmatterLists: { anyOf: [ { type: "array", items: { type: "string" } }, { const: "*" } ] } } }
            },
            required: ["noteId"]
          }
        },
        {
          name: "get-note-neighborhood",
          description: `👥 Окрестность узла по слоям L1..Lk (входящие/исходящие)` ,
          inputSchema: {
            type: "object",
            properties: {
              noteId: { type: "string" }, depth: { type: "number", default: 2 }, fanoutLimit: { type: "number", default: 30 }, direction: { type: "string", enum: ["in","out","both"], default: "both" }, format: { type: "string", enum: ["text","json"], default: "text" }
            },
            required: ["noteId"]
          }
        },
        {
          name: "get-graph-snapshot",
          description: `🧭 Снимок подграфа (ego-граф от noteId или поддерево по folderPrefix)` ,
          inputSchema: {
            type: "object",
            properties: {
              scope: { type: "object", properties: { startNoteId: { type: "string" }, folderPrefix: { type: "string" } } },
              depth: { type: "number", default: 2 }, direction: { type: "string", enum: ["in","out","both"], default: "both" }, include: { type: "object", properties: { bodyLinks: { type: "boolean" }, fmLinks: { type: "boolean" } } }, maxNodes: { type: "number", default: 300 }, maxEdges: { type: "number", default: 1000 }, annotate: { type: "boolean", default: true }, format: { type: "string", enum: ["json","mermaid","dot","text"], default: "json" }, allowedRelations: { type: "array", items: { type: "string" } }, nodeFilter: { type: "object", properties: { pathPrefix: { type: "string" }, tagIncludes: { type: "array", items: { type: "string" } } } }
            }
          }
        },
        {
          name: "get-vault-tree",
          description: `🌲 Дерево папок с агрегатами (counts, latest mtime)` ,
          inputSchema: {
            type: "object",
            properties: { root: { type: "string" }, maxDepth: { type: "number", default: 3 }, includeFiles: { type: "boolean", default: false }, includeCounts: { type: "boolean", default: true }, sort: { type: "string", enum: ["name","mtime","count"], default: "name" }, limitPerDir: { type: "number", default: 50 }, format: { type: "string", enum: ["text","json"], default: "text" } }
          }
        },
        {
          name: "get-folder-contents",
          description: `📁 Содержимое папки с сортировкой и фильтрами` ,
          inputSchema: {
            type: "object",
            properties: { folderPath: { type: "string" }, recursive: { type: "boolean", default: false }, sortBy: { type: "string", enum: ["name","mtime","degreeIn","degreeOut"], default: "mtime" }, limit: { type: "number", default: 200 }, filter: { type: "object", properties: { ext: { type: "array", items: { type: "string" } }, type: { type: "string" }, tagIncludes: { type: "array", items: { type: "string" } } } }, format: { type: "string", enum: ["text","json","table"], default: "text" } },
            required: ["folderPath"]
          }
        },
        {
          name: "find-path-between",
          description: `🧵 Кратчайший путь между двумя заметками (BFS)` ,
          inputSchema: {
            type: "object",
            properties: { from: { type: "string" }, to: { type: "string" }, direction: { type: "string", enum: ["in","out","both"], default: "both" }, maxDepth: { type: "number", default: 5 }, allowedRelations: { type: "array", items: { type: "string" } }, format: { type: "string", enum: ["text","json","mermaid"], default: "text" } },
            required: ["from","to"]
          }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "search-notes") {
      let query = request.params.arguments?.libraryName as string;
      if (!query) {
        throw new Error("Missing required parameter: libraryName");
      }
      const args = request.params.arguments || {} as any;
      const limit = Number(args.limit) || 20;
      const mode = (args.mode as any) || 'balanced';
      const includeLinked = args.includeLinked !== false;

      // Поддержка пресетов: если строка начинается с preset:, заменяем на шаблон
      if (query.startsWith('preset:')) {
        const key = query.slice('preset:'.length);
        const preset = serverInstance!.getQueryPresets()[key];
        if (preset) {
          console.error(`🎛️ Using preset "${key}": ${preset}`);
          query = preset;
        } else {
          console.error(`❌ Preset not found: ${key}`);
        }
      }

      const results = serverInstance!.searchNotes(query, limit, { mode, includeLinked });
      
      // Форматируем результаты для отображения
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

    if (request.params.name === "find-uncategorized-notes") {
      const args = request.params.arguments || {} as any;
      const limit = Number(args.limit) || 20;
      const items = serverInstance!.findUncategorizedNotes({ limit });
      const formatted = items.map((i, idx) => `${idx + 1}. ${i.title} — \`${i.path}\` \n   reasons: ${i.reasons.join(', ')}`).join('\n');
      return {
        content: [{ type: 'text', text: (items.length ? `🧹 Found ${items.length} uncategorized notes:\n\n${formatted}` : '✅ No uncategorized notes found.') }]
      };
    }

    if (request.params.name === "normalize-note-baseline") {
      const args = request.params.arguments || {} as any;
      const filePath = String(args.filePath || '');
      const dryRun = Boolean(args.dryRun);
      if (!filePath) throw new Error('filePath is required');
      const res = serverInstance!.normalizeNoteBaseline({ filePath, dryRun });
      return {
        content: [{ type: 'text', text: `🧰 Normalized: \`${res.path}\`\nUpdated keys: ${res.updatedKeys.join(', ') || 'none'}\nGuess: ${JSON.stringify(res.guessed, null, 2)}` }]
      };
    }

    if (request.params.name === "get-note-content") {
      let noteId = request.params.arguments?.context7CompatibleLibraryID as string;
      const maxTokens = request.params.arguments?.tokens as number;
      let topic = request.params.arguments?.topic as string;

      if (!noteId) {
        throw new Error("Missing required parameter: context7CompatibleLibraryID");
      }

      // поддержка file#heading
      let headingFromId: string | undefined;
      if (noteId.includes('#')) {
        const [base, head] = noteId.split('#');
        noteId = base;
        if (!topic && head) headingFromId = head;
      }

      // Канонизируем (учитывая алиасы)
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

      // Точное извлечение секции по заголовку, если задано
      let content = fullContent;

      const tryExtractByHeading = (text: string, heading: string): string | null => {
        try {
          const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const lines = text.split('\n');
          const rx = new RegExp(`^#{1,6}\\s+${esc(heading)}\\s*$`, 'i');
          let start = -1, level = 0;
          for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^(#+)\s+(.*)$/);
            if (!m) continue;
            const hl = m[1].length;
            const title = m[2].trim();
            if (rx.test(lines[i]) || title.toLowerCase() === heading.toLowerCase()) {
              start = i; level = hl; break;
            }
          }
          if (start === -1) return null;
          let end = lines.length;
          for (let j = start + 1; j < lines.length; j++) {
            const mm = lines[j].match(/^(#+)\s+/);
            if (mm) { const l = mm[1].length; if (l <= level) { end = j; break; } }
          }
          return lines.slice(start, end).join('\n');
        } catch { return null; }
      };

      const targetHeading = headingFromId || topic;
      if (targetHeading) {
        const section = tryExtractByHeading(fullContent, targetHeading);
        if (section) {
          content = section + '\n\n📄 **Full content below:**\n\n' + fullContent;
        } else {
          const notFoundMsg = `🔎 Heading not found: "${targetHeading}"`;
          if (topic) {
            // fallback: контекст вокруг совпадений
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
            } else {
              content = notFoundMsg + '\n\n' + fullContent;
            }
          } else {
            content = notFoundMsg + '\n\n' + fullContent;
          }
        }
      }

      // Если задан topic и не было headingFromId, но совпадений не нашли — добавим подсказку
      if (!headingFromId && topic) {
        const lines = fullContent.split('\n');
        const topicLower = topic.toLowerCase();
        const matched = lines.some(l => l.toLowerCase().includes(topicLower));
        if (!matched) {
          content = `🔎 Topic not found: "${topic}"` + '\n\n' + fullContent;
        }
      }

      // Ограничиваем содержимое если указан лимит токенов
      if (maxTokens && maxTokens > 0) {
        const approximateTokens = content.length / 4; // Примерно 4 символа = 1 токен
        if (approximateTokens > maxTokens) {
          content = content.substring(0, maxTokens * 4) + '\n\n... (содержимое обрезано по лимиту токенов)';
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

    if (request.params.name === "write-note") {
      const args = request.params.arguments || {} as any;
      const filePath = args.filePath as string;
      const content = args.content as string;
      const writeMode = (args.writeMode as 'create' | 'overwrite' | 'append') || 'create';
      const heading = args.heading as (string | undefined);
      const frontmatter = args.frontmatter as (Record<string, any> | undefined);
      const ensureMdExtension = (args.ensureMdExtension as boolean) ?? true;
      const createMissingFolders = (args.createMissingFolders as boolean) ?? true;

      if (!filePath || !content) {
        throw new Error("Missing required parameters: filePath, content");
      }

      const result = serverInstance!.writeNote({
        filePath,
        content,
        writeMode,
        heading,
        frontmatter,
        ensureMdExtension,
        createMissingFolders
      });

      return {
        content: [
          {
            type: "text",
            text: `✅ Note written successfully\n\n- Path: ${result.relativePath}\n- Absolute: ${result.absolutePath}\n- Mode: ${writeMode}\n- Bytes: ${result.bytesWritten}\n- Created: ${result.created}\n- Overwritten: ${result.overwritten}\n- Appended: ${result.appended}`
          }
        ]
      };
    }

    if (request.params.name === "append-under-heading") {
      const args = request.params.arguments || {} as any;
      const filePath = args.filePath as string;
      const heading = args.heading as string;
      const rawContent = args.content as string;
      const bullet = (args.bullet as boolean) ?? false;
      const timestamp = (args.timestamp as boolean) ?? false;
      const ensureMdExtension = (args.ensureMdExtension as boolean) ?? true;
      const createMissingFolders = (args.createMissingFolders as boolean) ?? true;

      if (!filePath || !heading || !rawContent) {
        throw new Error("Missing required parameters: filePath, heading, content");
      }

      const content = `${bullet ? '- ' : ''}${timestamp ? new Date().toISOString() + ' ' : ''}${rawContent}`;

      const result = serverInstance!.writeNote({
        filePath,
        content,
        writeMode: 'append',
        heading,
        ensureMdExtension,
        createMissingFolders
      });

      return {
        content: [
          {
            type: "text",
            text: `✅ Appended under heading\n\n- Path: ${result.relativePath}\n- Heading: ${heading}\n- Bytes: ${result.bytesWritten}`
          }
        ]
      };
    }

    if (request.params.name === "create-node") {
      const args = request.params.arguments || {} as any;
      const result = serverInstance!.createNode({
        filePath: args.filePath,
        title: args.title,
        type: args.type,
        properties: args.properties,
        content: args.content,
        ensureMdExtension: (args.ensureMdExtension as boolean) ?? true,
        createMissingFolders: (args.createMissingFolders as boolean) ?? true
      });
      return {
        content: [
          { type: "text", text: `✅ Node created at ${result.relativePath}` }
        ]
      };
    }

    if (request.params.name === "link-notes") {
      const args = request.params.arguments || {} as any;
      const res = serverInstance!.linkNotes({
        fromPath: args.fromPath,
        toPath: args.toPath,
        relation: args.relation || 'related',
        mode: (args.mode as 'property' | 'body' | 'both') || 'both',
        bidirectional: (args.bidirectional as boolean) ?? true,
        heading: args.heading || 'Relations'
      });
      return {
        content: [
          { type: "text", text: `✅ Linked: ${res.fromPath} ⇄ ${res.toPath} (${res.mode}/${res.relation})` }
        ]
      };
    }

    if (request.params.name === "upsert-frontmatter") {
      const args = request.params.arguments || {} as any;
      const res = serverInstance!.upsertFrontmatter({
        filePath: args.filePath,
        set: args.set,
        removeKeys: args.removeKeys,
        ensureMdExtension: (args.ensureMdExtension as boolean) ?? true,
        createMissingFolders: (args.createMissingFolders as boolean) ?? true
      });
      return {
        content: [
          { type: "text", text: `✅ Frontmatter updated: ${res.relativePath}` }
        ]
      };
    }

    if (request.params.name === "unlink-notes") {
      const args = request.params.arguments || {} as any;
      const res = serverInstance!.unlinkNotes({
        fromPath: args.fromPath,
        toPath: args.toPath,
        relation: args.relation || 'related',
        mode: (args.mode as 'property' | 'body' | 'both') || 'both',
        bidirectional: (args.bidirectional as boolean) ?? true,
        heading: args.heading || 'Relations'
      });
      return {
        content: [
          { type: "text", text: `✅ Unlinked: ${args.fromPath} ↮ ${args.toPath} (${args.mode || 'both'}/${args.relation || 'related'})` }
        ]
      };
    }

    if (request.params.name === "reindex-vault") {
      const res = await serverInstance!.reindexVault();
      return {
        content: [
          { type: "text", text: `🔄 Reindexed notes: ${res.notes}` }
        ]
      };
    }

    if (request.params.name === "repair-graph") {
      const res = serverInstance!.repairGraph();
      return { content: [{ type: 'text', text: `🧹 Graph repaired: ${res.fixed} relations ensured/cleaned` }] };
    }

    if (request.params.name === "apply-template") {
      const args = request.params.arguments || {} as any;
      const rendered = serverInstance!.applyTemplate({
        template: args.template,
        variables: args.variables,
        filePath: args.filePath,
        writeMode: args.writeMode,
        heading: args.heading
      });
      const pathInfo = rendered.writtenPath ? `\nWritten to: ${rendered.writtenPath}` : '';
      return { content: [{ type: 'text', text: `✅ Template applied${pathInfo}\n\n${rendered.content}` }] };
    }

    if (request.params.name === "bulk-autolink") {
      const args = request.params.arguments || {} as any;
      const res = serverInstance!.bulkAutolink({ mappings: args.mappings || [], maxPerFile: args.maxPerFile, limitFiles: args.limitFiles });
      return { content: [{ type: 'text', text: `🔗 Bulk autolink updated files: ${res.updatedFiles}` }] };
    }

    if (request.params.name === "note-move") {
      const args = request.params.arguments || {} as any;
      const res = serverInstance!.moveNote({ fromPath: args.fromPath, toPath: args.toPath, overwrite: args.overwrite });
      return { content: [{ type: 'text', text: `📦 Moved: ${res.from} → ${res.to}` }] };
    }

    if (request.params.name === "note-clone") {
      const args = request.params.arguments || {} as any;
      const res = serverInstance!.cloneNote({ fromPath: args.fromPath, toPath: args.toPath, setTitle: args.setTitle });
      return { content: [{ type: 'text', text: `📄 Cloned: ${res.from} → ${res.to}` }] };
    }

    if (request.params.name === "note-delete") {
      const args = request.params.arguments || {} as any;
      const res = serverInstance!.deleteNote({ path: args.path });
      return { content: [{ type: 'text', text: `🗑️ Deleted: ${res.deletedPath}` }] };
    }

    if (request.params.name === "get-graph-summary") {
      const args = request.params.arguments || {} as any;
      const noteId = args.noteId as string;
      const depth = Math.max(1, Math.min(3, (args.depth as number) || 1));
      const direction = (args.direction as 'in'|'out'|'both') || 'both';
      const relation = args.relation as (string|undefined);

      const startPath = serverInstance!.getNotePathFromId(noteId);
      if (!startPath) throw new Error(`Note not found: ${noteId}`);

      const visited = new Set<string>();
      const layers: string[][] = [];
      let current = [startPath];
      visited.add(startPath);

      for (let d = 0; d < depth; d++) {
        const next: string[] = [];
        const layer: string[] = [];
        for (const p of current) {
          let outs: string[] = [];
          let ins: string[] = [];
          if (direction === 'out' || direction === 'both') outs = serverInstance!.getOutgoingPathsPub(p);
          if (direction === 'in' || direction === 'both') ins = serverInstance!.getBacklinkPathsPub(p);
          const all = [...outs, ...ins];
          for (const q of all) {
            if (!visited.has(q)) {
              visited.add(q);
              layer.push(q);
              next.push(q);
            }
          }
        }
        if (layer.length > 0) layers.push(layer);
        current = next;
      }

      const lines: string[] = [];
      lines.push(`Root: ${startPath}`);
      layers.forEach((layer, i) => {
        lines.push(`Depth ${i+1}:`);
        for (const p of layer) {
          const n = serverInstance!.getIndexData().find(x => x.path === p);
          const degOut = serverInstance!.getOutgoingPathsPub(p).length;
          const degIn = serverInstance!.getBacklinkPathsPub(p).length;
          lines.push(`- ${p} (${(n?.title)||''}) out:${degOut} in:${degIn}`);
        }
      });

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (request.params.name === "find-unlinked-mentions") {
      const args = request.params.arguments || {} as any;
      const terms: string[] = (args.terms as string[]) || [];
      const maxPerFile = (args.maxPerFile as number) ?? 3;
      const limitFiles = (args.limitFiles as number) ?? 30;

      const patterns = terms.map(t => ({ term: t, re: new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') }));
      const suggestions: string[] = [];
      let filesCount = 0;
      for (const n of serverInstance!.getIndexData()) {
        // Игнор системных/плагинных путей
        if (n.path.startsWith('.obsidian/') || n.path.includes('/node_modules/')) continue;
        if (filesCount >= limitFiles) break;
        const text = (n.content || n.content_preview || '');
        let hits = 0;
        for (const { term, re } of patterns) {
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) !== null) {
            const idx = m.index;
            const before = text.slice(Math.max(0, idx - 2), idx);
            if (before === '[[') continue; // уже линк
            const start = Math.max(0, idx - 40);
            const end = Math.min(text.length, idx + term.length + 40);
            const snippet = text.slice(start, end).replace(/\n/g, ' ');
            suggestions.push(`- ${n.path}: …${snippet}…`);
            hits++;
            if (hits >= maxPerFile) break;
          }
          if (hits >= maxPerFile) break;
        }
        if (hits > 0) filesCount++;
      }

      const outText = suggestions.length ? suggestions.join('\n') : 'No unlinked mentions found';
      return { content: [{ type: 'text', text: outText }] };
    }

    if (request.params.name === "capture-note") {
      const args = request.params.arguments || {} as any;
      const res = serverInstance!.captureNote({
        name: String(args.name || ''),
        content: String(args.content || ''),
        tags: Array.isArray(args.tags) ? args.tags : undefined,
        relations: Array.isArray(args.relations) ? args.relations : undefined,
        folder: args.folder,
        linkToHub: (args.linkToHub as boolean) ?? true
      });
      return { content: [{ type: 'text', text: `✅ Captured: ${res.path}` }] };
    }

    if (request.params.name === "daily-journal-append") {
      const args = request.params.arguments || {} as any;
      const res = serverInstance!.dailyJournalAppend({
        content: String(args.content || ''),
        heading: args.heading,
        bullet: (args.bullet as boolean) ?? true,
        timestamp: (args.timestamp as boolean) ?? true,
        filePath: args.filePath,
        date: args.date
      });
      return { content: [{ type: 'text', text: `🗒️ Appended to daily: ${res.path}` }] };
    }

    if (request.params.name === "embed-and-upsert") {
      const args = request.params.arguments || {} as any;
      const noteId = String(args.noteId || '');
      if (!noteId) throw new Error('noteId is required');
      const res = serverInstance!.embedAndUpsert({ noteId, mode: args.mode });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }

    if (request.params.name === "semantic-build-index") {
      const args = request.params.arguments || {} as any;
      const res = serverInstance!.semanticBuildIndex({ limit: args.limit });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }

    if (request.params.name === "semantic-query") {
      const args = request.params.arguments || {} as any;
      const res = serverInstance!.semanticQuery({ query: String(args.query||''), topK: args.topK, offset: args.offset, filters: args.filters });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }

    if (request.params.name === "reindex-changed-since") {
      const args = request.params.arguments || {} as any;
      const sinceIso = args.since as string;
      const since = new Date(sinceIso).getTime();
      if (Number.isNaN(since)) throw new Error('Invalid ISO date');

      const vaultRoot = path.resolve(serverInstance!.getVaultRoot());
      let changed = 0;
      const walk = (dir: string) => {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const full = path.join(dir, entry);
          const st = statSync(full);
          if (st.isDirectory()) walk(full);
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

    if (request.params.name === "resolve-note") {
      const input = String((request.params.arguments || {} as any).input || '');
      if (!input) throw new Error('input is required');
      const res = serverInstance!.resolveNotePublic(input);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }

    if (request.params.name === "get-relations-of-note") {
      const args = request.params.arguments || {} as any;
      const noteId = String(args.noteId || '');
      if (!noteId) throw new Error('noteId is required');
      const res = serverInstance!.getRelationsOfNote({ noteId, include: args.include });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }

    if (request.params.name === "get-note-neighborhood") {
      const args = request.params.arguments || {} as any;
      const res = serverInstance!.getNoteNeighborhood({
        noteId: String(args.noteId || ''),
        depth: args.depth,
        fanoutLimit: args.fanoutLimit,
        direction: args.direction,
        format: args.format
      });
      const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
      return { content: [{ type: 'text', text }] };
    }

    if (request.params.name === "get-graph-snapshot") {
      const args = request.params.arguments || {} as any;
      const res = serverInstance!.getGraphSnapshot({
        scope: args.scope,
        depth: args.depth,
        direction: args.direction,
        include: args.include,
        maxNodes: args.maxNodes,
        maxEdges: args.maxEdges,
        annotate: args.annotate,
        format: args.format,
        allowedRelations: args.allowedRelations
      });
      const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
      return { content: [{ type: 'text', text }] };
    }

    if (request.params.name === "get-vault-tree") {
      const args = request.params.arguments || {} as any;
      const tree = serverInstance!.buildVaultTree({ root: args.root, maxDepth: args.maxDepth, includeFiles: args.includeFiles, includeCounts: args.includeCounts, sort: args.sort, limitPerDir: args.limitPerDir });
      if ((args.format || 'text') === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }] };
      }
      // text renderer
      const lines: string[] = [];
      const walk = (node: any, depth: number) => {
        const indent = '  '.repeat(depth);
        if (node.type === 'directory') {
          const info = node.counts ? ` (md: ${node.counts.md_files || 0}${node.mtimeLatest ? `, latest: ${node.mtimeLatest.slice(0,10)}`:''})` : '';
          lines.push(`${indent}${node.path || node.name}${info}`);
          for (const c of node.children || []) walk(c, depth + 1);
        } else {
          lines.push(`${indent}- ${node.name}${node.mtime ? ` (${node.mtime})`:''}`);
        }
      };
      walk(tree, 0);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (request.params.name === "get-folder-contents") {
      const args = request.params.arguments || {} as any;
      const rows = serverInstance!.buildFolderContents({ folderPath: String(args.folderPath || ''), recursive: args.recursive, sortBy: args.sortBy, limit: args.limit, filter: args.filter });
    if ((args.format || 'text') === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
      }
      if ((args.format || 'text') === 'table') {
        const header: string[] = ['Title','Path','mtime','in','out'];
        const widths: number[] = [
          Math.max(header[0].length, ...rows.map(r=> (r.title||'').length)),
          Math.max(header[1].length, ...rows.map(r=> (r.path||'').length)),
          Math.max(header[2].length, ...rows.map(r=> (r.mtime||'').length)),
          Math.max(header[3].length, ...rows.map(r=> String(r.degreeIn).length)),
          Math.max(header[4].length, ...rows.map(r=> String(r.degreeOut).length))
        ];
        const pad = (s: string, w: number): string => (s + ' '.repeat(Math.max(0, w - s.length)));
        const line = (cols: Array<string|number>): string => cols.map((c, i)=> pad(String(c), widths[i])).join('  ');
        const lines: string[] = [line(header), line(widths.map(w=>'-'.repeat(w)))];
        for (const r of rows) lines.push(line([r.title, r.path, r.mtime||'', r.degreeIn, r.degreeOut]));
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
      const text = rows.map(r => `- ${r.title} — ${r.path}  (mtime: ${r.mtime}, in:${r.degreeIn} out:${r.degreeOut})`).join('\n');
      return { content: [{ type: 'text', text }] };
    }

    if (request.params.name === "find-path-between") {
      const args = request.params.arguments || {} as any;
      const res = serverInstance!.findPathBetween({ from: String(args.from || ''), to: String(args.to || ''), direction: args.direction, maxDepth: args.maxDepth, allowedRelations: args.allowedRelations, format: args.format });
      const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
      return { content: [{ type: 'text', text }] };
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  });

  return server;
}

// Главная функция запуска сервера
async function main() {
  // 🚀 ДЕТАЛЬНОЕ ЛОГГИРОВАНИЕ ПРИ ЗАПУСКЕ
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
