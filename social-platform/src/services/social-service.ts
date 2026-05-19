import { randomUUID } from 'crypto';
import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { join, dirname, extname } from 'path';
import { createReadStream } from 'fs';
import type { Readable } from 'node:stream';

export type MediaType = 'none' | 'image' | 'video';

export interface Post {
  id: string;
  authorId: string;
  text: string;
  mediaType: MediaType;
  mediaUrl: string | null;
  createdAt: string;
}

export interface Comment {
  id: string;
  postId: string;
  authorId: string;
  text: string;
  createdAt: string;
}

export interface Report {
  id: string;
  postId: string;
  reporterId: string;
  reason: string;
  createdAt: string;
}

const MAX_POSTS = 1000;
const MAX_COMMENTS_PER_POST = 200;
const MAX_REPORTS = 5000;
const MAX_MEDIA_BYTES = 12 * 1024 * 1024; // 12MB

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

const ALLOWED_IMAGE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const ALLOWED_VIDEO = new Set(['video/mp4', 'video/webm']);

export class SocialService {
  private posts: Post[] = [];
  private comments: Comment[] = [];
  private reports: Report[] = [];
  private likes = new Map<string, Set<string>>(); // postId -> Set<userId>
  private readonly postIds = new Set<string>();
  private readonly commentsByPostId = new Map<string, Comment[]>();
  private mediaRoot: string;
  private persistPath: string;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    persistPath: string = join(process.cwd(), 'data', 'social-feed.json'),
    mediaRoot: string = join(process.cwd(), 'data', 'social-media')
  ) {
    this.persistPath = persistPath;
    this.mediaRoot = mediaRoot;
  }

  async load(): Promise<void> {
    try {
      const data = await readFile(this.persistPath, 'utf8');
      const parsed = JSON.parse(data);
      
      this.posts = (parsed.posts || []).filter((p: any) => p?.id && p?.authorId);
      this.comments = (parsed.comments || []).filter((c: any) => c?.id && c?.postId && c?.authorId);
      this.reports = (parsed.reports || []).filter((r: any) => r?.id && r?.postId && r?.reporterId);
      
      this.likes = new Map();
      if (parsed.likes && typeof parsed.likes === 'object') {
        for (const [pid, arr] of Object.entries(parsed.likes)) {
          if (Array.isArray(arr)) {
            this.likes.set(pid, new Set(arr.map((s: any) => String(s))));
          }
        }
      }

      this.postIds.clear();
      for (const p of this.posts) this.postIds.add(p.id);
      
      this.reindexCommentsByPost();
      
      console.log(`[SocialService] Loaded ${this.posts.length} posts, ${this.comments.length} comments`);
    } catch (error) {
      console.log('[SocialService] No existing data file, starting fresh');
    }
  }

  private reindexCommentsByPost(): void {
    this.commentsByPostId.clear();
    for (const c of this.comments) {
      const arr = this.commentsByPostId.get(c.postId);
      if (arr) arr.push(c);
      else this.commentsByPostId.set(c.postId, [c]);
    }
  }

  async saveUploadedMedia(
    buffer: Buffer,
    mime: string
  ): Promise<{ ok: true; mediaUrl: string } | { ok: false; reason: string }> {
    const m = mime.toLowerCase().split(';')[0]!.trim();
    
    if (!ALLOWED_IMAGE.has(m) && !ALLOWED_VIDEO.has(m)) {
      return { ok: false, reason: '不支持的媒体类型' };
    }

    if (buffer.length > MAX_MEDIA_BYTES) {
      return { ok: false, reason: `文件过大（>${MAX_MEDIA_BYTES} 字节）` };
    }

    const ext = MIME_EXT[m];
    if (!ext) return { ok: false, reason: '不支持的媒体类型' };

    const fileName = `${randomUUID().replace(/-/g, '')}.${ext}`;
    await mkdir(this.mediaRoot, { recursive: true });
    const abs = join(this.mediaRoot, fileName);
    await writeFile(abs, buffer);

    return { ok: true, mediaUrl: `/social/media/${fileName}` };
  }

  createPost(
    authorId: string,
    text: string,
    mediaType: MediaType,
    mediaUrl: string | null
  ): { ok: true; post: Post } | { ok: false; reason: string } {
    const t = text.trim();
    
    if (!t && mediaType === 'none') {
      return { ok: false, reason: '正文与媒体不能同时为空' };
    }

    if (t.length > 4000) return { ok: false, reason: '正文过长' };

    if (mediaType !== 'none') {
      if (!mediaUrl || !this.isValidMediaUrl(mediaUrl)) {
        return { ok: false, reason: '媒体须为 https 外链或本服务上传后的路径' };
      }
    } else if (mediaUrl && mediaUrl.trim().length > 0) {
      return { ok: false, reason: 'mediaType 为 none 时不应带 mediaUrl' };
    }

    const post: Post = {
      id: `post_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      authorId,
      text: t,
      mediaType,
      mediaUrl: mediaType === 'none' ? null : mediaUrl!.trim(),
      createdAt: new Date().toISOString(),
    };

    this.posts.unshift(post);
    this.postIds.add(post.id);

    if (this.posts.length > MAX_POSTS) {
      const drop = this.posts.splice(MAX_POSTS);
      const dropIds = new Set(drop.map((p) => p.id));
      
      for (const p of drop) {
        this.postIds.delete(p.id);
        this.commentsByPostId.delete(p.id);
        this.likes.delete(p.id);
        void this.unlinkServerMedia(p.mediaUrl);
      }
      
      this.comments = this.comments.filter((c) => !dropIds.has(c.postId));
      this.reports = this.reports.filter((r) => !dropIds.has(r.postId));
    }

    void this.schedulePersist();
    return { ok: true, post };
  }

  deletePost(
    actorId: string,
    postId: string
  ): { ok: true } | { ok: false; reason: string } {
    const idx = this.posts.findIndex((p) => p.id === postId);
    if (idx < 0) return { ok: false, reason: '帖子不存在' };

    const post = this.posts[idx]!;
    if (post.authorId !== actorId) {
      return { ok: false, reason: '只能删除本人发布的帖子' };
    }

    this.posts.splice(idx, 1);
    this.postIds.delete(postId);
    this.commentsByPostId.delete(postId);
    this.comments = this.comments.filter((c) => c.postId !== postId);
    this.likes.delete(postId);
    this.reports = this.reports.filter((r) => r.postId !== postId);
    void this.unlinkServerMedia(post.mediaUrl);
    void this.schedulePersist();

    return { ok: true };
  }

  addComment(
    authorId: string,
    postId: string,
    text: string
  ): { ok: true; comment: Comment } | { ok: false; reason: string } {
    if (!this.postIds.has(postId)) return { ok: false, reason: '帖子不存在' };

    const t = text.trim();
    if (!t) return { ok: false, reason: '评论不能为空' };
    if (t.length > 2000) return { ok: false, reason: '评论过长' };

    const existing = this.commentsByPostId.get(postId) ?? [];
    if (existing.length >= MAX_COMMENTS_PER_POST) {
      return { ok: false, reason: '该帖评论已达上限' };
    }

    const comment: Comment = {
      id: `cmt_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      postId,
      authorId,
      text: t,
      createdAt: new Date().toISOString(),
    };

    this.comments.push(comment);
    const bucket = this.commentsByPostId.get(postId);
    if (bucket) bucket.push(comment);
    else this.commentsByPostId.set(postId, [comment]);

    void this.schedulePersist();
    return { ok: true, comment };
  }

  toggleLike(
    userId: string,
    postId: string
  ): { ok: true; liked: boolean; likeCount: number } | { ok: false; reason: string } {
    if (!this.postIds.has(postId)) return { ok: false, reason: '帖子不存在' };

    let set = this.likes.get(postId);
    if (!set) {
      set = new Set();
      this.likes.set(postId, set);
    }

    let liked: boolean;
    if (set.has(userId)) {
      set.delete(userId);
      liked = false;
    } else {
      set.add(userId);
      liked = true;
    }

    const likeCount = set.size;
    void this.schedulePersist();
    return { ok: true, liked, likeCount };
  }

  reportPost(
    reporterId: string,
    postId: string,
    reason?: string
  ): { ok: true; duplicate?: boolean } | { ok: false; reason: string } {
    if (!this.postIds.has(postId)) return { ok: false, reason: '帖子不存在' };

    if (this.reports.some((r) => r.postId === postId && r.reporterId === reporterId)) {
      return { ok: true, duplicate: true };
    }

    const r = (reason ?? '').trim().slice(0, 500);
    const row: Report = {
      id: `rpt_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      postId,
      reporterId,
      reason: r,
      createdAt: new Date().toISOString(),
    };

    this.reports.push(row);
    if (this.reports.length > MAX_REPORTS) {
      this.reports.splice(0, this.reports.length - MAX_REPORTS);
    }

    void this.schedulePersist();
    return { ok: true };
  }

  getFeedForViewer(viewerId: string, limit = 80): { posts: any[] } {
    const lim = Math.min(200, Math.max(1, Math.floor(limit)));
    const sorted = this.sortedPostsForViewer(viewerId);
    const slice = sorted.slice(0, lim);

    return {
      posts: slice.map((p) => this.serializePost(p, viewerId)),
    };
  }

  private sortedPostsForViewer(viewerId: string): Post[] {
    const mine: Post[] = [];
    const rest: Post[] = [];

    for (const p of this.posts) {
      if (p.authorId === viewerId) mine.push(p);
      else rest.push(p);
    }

    return [...mine, ...rest];
  }

  private serializePost(p: Post, viewerId: string): any {
    const likeSet = this.likes.get(p.id) ?? new Set<string>();
    const reportStats = this.reportStatsForPost(p.id, viewerId);

    return {
      id: p.id,
      authorId: p.authorId,
      text: p.text,
      mediaType: p.mediaType,
      mediaUrl: p.mediaUrl,
      createdAt: p.createdAt,
      likeCount: likeSet.size,
      likedByViewer: likeSet.has(viewerId),
      isOwnPost: p.authorId === viewerId,
      reportCount: reportStats.count,
      viewerHasReported: reportStats.viewerReported,
      comments: this.commentsForPost(p.id).map((c) => ({
        id: c.id,
        authorId: c.authorId,
        text: c.text,
        createdAt: c.createdAt,
      })),
    };
  }

  private commentsForPost(postId: string): Comment[] {
    const rows = this.commentsByPostId.get(postId);
    if (!rows?.length) return [];
    return rows.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private reportStatsForPost(postId: string, viewerId: string): { count: number; viewerReported: boolean } {
    let count = 0;
    let viewerReported = false;

    for (const r of this.reports) {
      if (r.postId !== postId) continue;
      count += 1;
      if (r.reporterId === viewerId) viewerReported = true;
    }

    return { count, viewerReported };
  }

  private isValidMediaUrl(url: string): boolean {
    const u = url.trim();
    if (u.startsWith('/social/media/')) {
      const name = u.slice('/social/media/'.length);
      return /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z0-9]{2,8}$/.test(name);
    }
    if (u.startsWith('https://')) {
      try {
        const parsed = new URL(u);
        return parsed.protocol === 'https:' && !!parsed.hostname && parsed.hostname !== 'localhost';
      } catch {
        return false;
      }
    }
    return false;
  }

  private async unlinkServerMedia(mediaUrl: string | null): Promise<void> {
    if (!mediaUrl || !mediaUrl.startsWith('/social/media/')) return;
    
    const name = mediaUrl.slice('/social/media/'.length);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z0-9]{2,8}$/.test(name)) return;

    try {
      await unlink(join(this.mediaRoot, name));
    } catch {
      // 文件已删除或不存在
    }
  }

  createMediaReadStream(fileName: string): Readable | null {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z0-9]{2,8}$/.test(fileName)) return null;
    return createReadStream(join(this.mediaRoot, fileName));
  }

  mimeForFileName(fileName: string): string {
    const ext = extname(fileName).toLowerCase();
    const map: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
    };
    return map[ext] ?? 'application/octet-stream';
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistToDisk();
    }, 500);
  }

  async flushPersist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persistToDisk();
  }

  private async persistToDisk(): Promise<void> {
    const likesObj: Record<string, string[]> = {};
    for (const [pid, set] of this.likes) {
      likesObj[pid] = [...set];
    }

    const body = {
      version: 1,
      posts: this.posts,
      comments: this.comments,
      likes: likesObj,
      reports: this.reports,
    };

    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      await writeFile(this.persistPath, JSON.stringify(body, null, 2), 'utf8');
    } catch (error) {
      console.error('[SocialService] Persist failed:', error);
    }
  }
}
