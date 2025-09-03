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
  
  // 🚀 УМНОЕ КЭШИРОВАНИЕ
  private searchCache = new Map<string, {results: SearchResult[], timestamp: number, hitCount: number}>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 минут
  private readonly MAX_CACHE_SIZE = 100; // Максимум 100 запросов в кэше
  
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
        
        // 🚀 Очищаем кэш при обновлении индекса
        this.clearCache();
        
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
    this.clearCache();
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
      this.clearCache();

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
    const enSuffixes = ['ing','edly','ed','es','s','ly','ment','ness','ation','ions','ion','er','ers'];
    for (const suf of enSuffixes) {
      if (w.endsWith(suf) && w.length - suf.length >= 3) { w = w.slice(0, -suf.length); break; }
    }
    const ruSuffixes = ['иями','ями','ами','ыми','ими','ого','ему','ому','ее','ие','ые','ая','яя','ою','ею','ую','ью','ой','ый','ий','ых','ов','ев','ам','ям','ах','ях','ом','ем','ую','ию','ясь','ешь','ишь','ить','ать','ять','ывать','ивать','ение','ений','ениям','ениями','енией','овать'];
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
    const note = this.getNote(noteId);
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
      try { this.indexSingleFile(relWithExt); } catch {}
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
    try { this.indexSingleFile(relWithExt); } catch {}
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
    try { this.indexSingleFile(relWithExt); } catch {}
  }

  private appendRelationBody(filePath: string, heading: string, wikilink: string): void {
    const vaultRoot = path.resolve(this.vaultPath);
    const relWithExt = filePath.toLowerCase().endsWith('.md') ? filePath : `${filePath}.md`;
    const absolutePath = path.resolve(vaultRoot, relWithExt.replace(/^\/+/, ''));
    if (!absolutePath.startsWith(vaultRoot)) throw new Error('Path escape detected');

    if (!existsSync(absolutePath)) {
      writeFileSync(absolutePath, `## ${heading}\n\n${wikilink}\n`, { encoding: 'utf-8' });
      return;
    }
    const original = readFileSync(absolutePath, 'utf-8');
    const updated = this.appendUnderHeading(original, heading, wikilink);
    writeFileSync(absolutePath, updated, { encoding: 'utf-8' });
    // 🔄 Инкрементальная индексация
    try { this.indexSingleFile(relWithExt); } catch {}
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
    try { this.indexSingleFile(relWithExt); } catch {}
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
      try { this.indexSingleFile(relWithExt); } catch {}
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
    try { this.indexSingleFile(relWithExt); } catch {}
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
    const targetKey = this.normalizeNoteKey(toPath);
    const result = new Set<string>();
    for (const n of this.indexData) {
      const keys = this.extractWikiLinks(n.content || n.content_preview || '');
      if (keys.includes(targetKey)) result.add(n.path);
      const { frontmatter } = this.parseFrontmatterAndBody(n.content || '');
      for (const v of Object.values(frontmatter)) {
        if (Array.isArray(v)) {
          for (const item of v) {
            if (typeof item === 'string' && /\[\[[^\]]+\]\]/.test(item)) {
              const key = this.normalizeNoteKey(item.replace(/^\[\[|\]\]$/g, '').split('#')[0]);
              if (key === targetKey) result.add(n.path);
            }
          }
        }
      }
    }
    return [...result];
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
      try { this.indexSingleFile(indexPath); } catch {}
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
    try { this.indexSingleFile(toRel); } catch {}
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
    try { this.indexSingleFile(toRel); } catch {}
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
      if (noteId.includes('#') && !topic) {
        const [base, head] = noteId.split('#');
        noteId = base;
        topic = head || topic;
      }

      const fullContent = serverInstance!.getFullNoteContent(noteId);
      
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

      // Ограничиваем содержимое если указан лимит токенов
      let content = fullContent;
      if (maxTokens && maxTokens > 0) {
        const approximateTokens = content.length / 4; // Примерно 4 символа = 1 токен
        if (approximateTokens > maxTokens) {
          content = content.substring(0, maxTokens * 4) + '\n\n... (содержимое обрезано по лимиту токенов)';
        }
      }

      // Если указана тема, пытаемся найти релевантные секции
      if (topic) {
        const lines = content.split('\n');
          const topicLower = topic.toLowerCase();
        const relevantSections: string[] = [];
          
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
            if (line.toLowerCase().includes(topicLower)) {
            // Добавляем контекст: 3 строки до и 5 строк после
            const start = Math.max(0, i - 3);
            const end = Math.min(lines.length, i + 6);
            const section = lines.slice(start, end).join('\n');
            relevantSections.push(section);
          }
        }
        
        if (relevantSections.length > 0) {
          content = `📍 **Sections related to "${topic}":**\n\n` + 
                   relevantSections.join('\n\n---\n\n') + 
                   '\n\n📄 **Full content below:**\n\n' + content;
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
