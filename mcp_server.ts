#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { 
  CallToolRequestSchema,
  ListToolsRequestSchema 
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "url";
import path from "path";
import { readFileSync, existsSync } from "fs";
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

    // Извлекаем точные фразы в кавычках
    const phraseRegex = /"([^"]+)"/g;
    let match;
    while ((match = phraseRegex.exec(query)) !== null) {
      result.exactPhrases.push(match[1].toLowerCase());
      query = query.replace(match[0], ''); // Удаляем обработанную фразу
    }

    // Извлекаем поиск по полям (title:значение, path:значение, tags:значение)
    const fieldRegex = /(\w+):(\S+)/g;
    while ((match = fieldRegex.exec(query)) !== null) {
      result.fieldQueries.push({
        field: match[1].toLowerCase(),
        value: match[2].toLowerCase()
      });
      query = query.replace(match[0], ''); // Удаляем обработанную часть
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
    this.categories = this._initCategories();
    this.vaultPath = this.findVaultPath();
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
    const vaultPath = path.join(PLUGIN_ROOT, '../../');
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
        
        this.indexData = rawData.map((item, index) => ({
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

  // Инициализируем Fuse.js для мощного fuzzy поиска
  private initializeFuse(): void {
    const fuseOptions = {
      keys: [
        { name: 'title', weight: 0.5 },           // 🎯 Заголовок еще важнее (было 0.4)
        { name: 'path', weight: 0.2 },            // Путь тоже важен
        { name: 'description', weight: 0.1 },     // 🎯 Описание менее важно (было 0.15)
        { name: 'content', weight: 0.15 },        // 🎯 Содержимое менее важно (было 0.2)
        { name: 'tags', weight: 0.05 }            // Теги
      ],
      threshold: 0.25,       // 🎯 ФИНАЛ: разумно строгий (найдет релевантное, но не всё подряд)
      distance: 20,          // 🎯 ФИНАЛ: средняя дистанция для хорошего поиска
      minMatchCharLength: 3, // 🎯 ФИНАЛ: минимум 3 символа
      useExtendedSearch: true, // Включаем расширенный синтаксис поиска
      ignoreLocation: true   // Игнорируем расположение совпадения в тексте
    };

    this.fuse = new Fuse(this.indexData, fuseOptions);
    console.error(`🔧 Fuse.js initialized with ${this.indexData.length} searchable notes`);
  }

  // Расширяем поисковый запрос синонимами
  private expandQueryWithSynonyms(query: string): string[] {
    const expandedQueries = [query.toLowerCase()];
    const queryLower = query.toLowerCase();

    // Добавляем синонимы из словаря
    for (const [key, synonyms] of Object.entries(this.synonyms)) {
      if (key === queryLower || synonyms.some(syn => queryLower.includes(syn))) {
        expandedQueries.push(key);
        expandedQueries.push(...synonyms);
      }
    }

    // Убираем дубликаты и возвращаем уникальные запросы
    return [...new Set(expandedQueries)];
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
    const words = query.toLowerCase()
      .split(/[\s\-_.,;:!?()[\]{}"']+/) // Разбиваем по разделителям
      .filter(word => word.length >= 2)  // Только слова от 2 символов
      .filter(word => !/^\d+$/.test(word)); // Исключаем чисто числовые

    // Добавляем синонимы для найденных слов
    const expandedWords = [...words];
    for (const word of words) {
      for (const [key, synonyms] of Object.entries(this.synonyms)) {
        if (key === word || synonyms.includes(word)) {
          expandedWords.push(key, ...synonyms);
        }
      }
    }

    return [...new Set(expandedWords)]; // Убираем дубликаты
  }

  // Экранируем специальные символы для regex
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
        case 'content':
          fieldValue = (note.content || note.content_preview || '').toLowerCase();
          break;
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
          case 'content':
            fieldValue = (note.content || note.content_preview || '').toLowerCase();
            break;
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
  public searchNotes(query: string, limit: number = DEFAULT_LIMIT): SearchResult[] {
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

    console.error(`🔍 Searching: "${query}" in ${this.indexData.length} notes`);
    
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

    // 🔧 ИСПРАВЛЕНИЕ: Если есть только расширенные операторы без обычных терминов
    if (hasAdvancedOperators && searchTerms.length === 0) {
      console.error(`🔧 Using broad search for advanced operator filtering`);
      // Делаем широкий поиск по всем заметкам, используя любое общее слово
      const broadSearchTerms = ['readme', 'система', 'gambit', 'документация', 'тз'];
      for (const broadTerm of broadSearchTerms) {
        const results = this.fuse.search(broadTerm);
        allResults.push(...results);
      }
      
      // Если ничего не нашли широким поиском, берем все заметки
      if (allResults.length === 0) {
        allResults = this.indexData.map((note, index) => ({
          item: note,
          score: 0,
          refIndex: index
        }));
      }
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
    const highQualityResults = Array.from(uniqueResults.values())
      .filter((result: any) => {
        const score = result.score ?? 0; // 🔧 ИСПРАВЛЕНИЕ: обрабатываем undefined score как 0 (идеальный)
        return score < MIN_SCORE_THRESHOLD;
      })
      .sort((a: any, b: any) => (a.score ?? 0) - (b.score ?? 0)) // 🔧 ИСПРАВЛЕНИЕ: безопасная сортировка с undefined
      .slice(0, limit);
    
    console.error(`🎯 Quality filter: ${highQualityResults.length}/${uniqueResults.size} results passed (threshold: ${MIN_SCORE_THRESHOLD})`);

    // Конвертируем в формат SearchResult
    const searchResults: SearchResult[] = highQualityResults
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
        const smartSnippet = this.extractRelevantSnippet(originalContent, query, 300);
        const highlightedSnippet = this.highlightMatches(smartSnippet, query);
        
        return {
          id: note.id || 'unknown',
          title: this.highlightMatches(note.title || 'Untitled', query), // 🎯 Highlighting в заголовке!
          description: this.highlightMatches(note.description || '', query), // 🎯 Highlighting в описании!
          path: note.path,
          lastModified: note.lastModified || '',
          score,
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
    
    // 🔗 Добавляем связанные заметки к результатам!
    const enhancedResults = this.searchWithLinks(query, filteredResults, true);
    
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
    if (!note || !note.fullPath) {
      return null;
    }

    try {
      // Читаем полное содержимое файла
      const fullContent = readFileSync(note.fullPath, 'utf-8');
      console.error(`📄 Successfully read full content for: ${note.title} (${fullContent.length} chars)`);
      return fullContent;
    } catch (error) {
      console.error(`❌ Error reading full content for ${noteId}:`, error);
      return note.content || note.content_preview || null;
    }
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

  private _initCategories(): Record<string, string[]> {
    return {
      "programming": ["код", "функция", "класс", "переменная", "массив"],
      "infrastructure": ["сервер", "база", "конфиг", "модуль"],
      "documentation": ["документация", "описание", "readme"],
      "testing": ["тест", "проверка", "testing"]
    };
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
          description: `🔍 **ИДЕАЛЬНЫЙ ПОИСК** по заметкам Obsidian с мощными возможностями:

🎯 **HIGHLIGHTING** - найденные слова подсвечиваются жирным **текстом**
🔗 **СВЯЗАННЫЕ ЗАМЕТКИ** - автоматически находит связанные заметки  
🔍 **РАСШИРЕННЫЕ ОПЕРАТОРЫ**:
  • "точная фраза" - поиск точного совпадения
  • +обязательное слово - должно присутствовать
  • -исключить слово - не должно быть
  • title:заголовок - поиск в заголовках
  • path:путь - поиск по пути файла
  • tags:тег - поиск по тегам
  • content:содержимое - поиск в содержимом

📊 **КАТЕГОРИЗАЦИЯ** - результаты группируются по типам:
  📚 Документация, 📋 ТЗ, 💻 Код, 🎓 Обучение, ✅ TODO и др.

⚡ **УМНОЕ КЭШИРОВАНИЕ** - мгновенные повторные запросы
🧠 **FUZZY SEARCH** - находит даже при опечатках  
📈 **АНАЛИТИКА** - статистика поиска каждые 10 запросов

**Примеры запросов:**
- javascript код
- "техническое задание" +gambit -старый  
- title:readme path:docs
- функция массив база

Поиск работает на русском и английском языках с поддержкой синонимов.`,
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
          name: "get-note-content",
          description: `📄 Получить **ПОЛНОЕ СОДЕРЖИМОЕ** заметки по её ID, пути или заголовку. 

Возвращает весь текст заметки для полного анализа и работы с содержимым.

**Входные данные:**
- ID заметки (из результатов поиска)
- Путь к заметке (например, "документация/readme.md") 
- Заголовок заметки

**Возвращает:**
- Полный текст заметки в markdown формате
- Метаинформацию о заметке`,
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
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "search-notes") {
      const query = request.params.arguments?.libraryName as string;
      if (!query) {
        throw new Error("Missing required parameter: libraryName");
      }

      const results = serverInstance!.searchNotes(query);
      
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

    if (request.params.name === "get-note-content") {
      const noteId = request.params.arguments?.context7CompatibleLibraryID as string;
      const maxTokens = request.params.arguments?.tokens as number;
      const topic = request.params.arguments?.topic as string;

      if (!noteId) {
        throw new Error("Missing required parameter: context7CompatibleLibraryID");
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
