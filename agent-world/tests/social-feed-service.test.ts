import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SocialFeedService } from "../services/social-feed-service.js";
import type { WorldService } from "../services/world-service.js";
import type { WorldState } from "../services/world-service.js";

function minimalWorldState(): WorldState {
  return {
    roomId: "stub",
    ownerSessionId: "stub",
    sessionId: "stub",
    revision: 0,
    sceneId: "social",
    agentWorldRegistered: true,
    agentWorldCredits: 0,
    creditAuditTrail: [],
    ownedSkillIds: [],
    leisureCount: 0,
    a2aEscrowReserved: 0,
  };
}

function createStubWorldService(): WorldService {
  return {
    assertAgentWorldRegistered() {},
    visitSocial() {
      return minimalWorldState();
    },
  } as WorldService;
}

describe("SocialFeedService", () => {
  let tmpDir: string;
  let persistPath: string;
  let mediaRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agent-world-social-"));
    persistPath = join(tmpDir, "agent-world-social-feed.json");
    mediaRoot = join(tmpDir, "social-media");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("createPost + flushPersist 后磁盘可解析且 load 后 feed 一致", async () => {
    const feed = new SocialFeedService(createStubWorldService(), persistPath, mediaRoot);
    await feed.load();
    const r = feed.createPost("author-1", "hello feed", "none", null);
    expect(r.ok).toBe(true);
    await feed.flushPersist();
    const raw = JSON.parse(await readFile(persistPath, "utf8")) as { posts: { id: string; text: string }[] };
    expect(raw.posts).toHaveLength(1);
    expect(raw.posts[0]!.text).toBe("hello feed");

    const feed2 = new SocialFeedService(createStubWorldService(), persistPath, mediaRoot);
    await feed2.load();
    const viewer = feed2.getFeedForViewer("author-1", 20);
    expect(viewer.ok).toBe(true);
    const posts = viewer.feed.posts as { id: string; text: string }[];
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toBe("hello feed");
  });

  it("addComment / toggleLike / deletePost 与评论上限", async () => {
    const feed = new SocialFeedService(createStubWorldService(), persistPath, mediaRoot);
    await feed.load();
    const post = feed.createPost("a", "root", "none", null);
    expect(post.ok).toBe(true);
    const pid = post.post.id;

    const c1 = feed.addComment("u1", pid, "first");
    expect(c1.ok).toBe(true);
    const like = feed.toggleLike("u2", pid);
    expect(like.ok).toBe(true);
    expect(like.liked).toBe(true);
    expect(like.likeCount).toBe(1);

    const v = feed.getFeedForViewer("u2", 10);
    expect(v.ok).toBe(true);
    const p0 = (v.feed.posts as { likeCount: number; likedByViewer: boolean; comments: unknown[] }[])[0]!;
    expect(p0.likeCount).toBe(1);
    expect(p0.likedByViewer).toBe(true);
    expect(p0.comments).toHaveLength(1);

    for (let i = 0; i < 79; i++) {
      const r = feed.addComment("u1", pid, `extra-${i}`);
      expect(r.ok).toBe(true);
    }
    const overflow = feed.addComment("u1", pid, "one-too-many");
    expect(overflow.ok).toBe(false);

    expect(feed.deletePost("wrong", pid).ok).toBe(false);
    expect(feed.deletePost("a", pid).ok).toBe(true);
    expect(feed.addComment("u1", pid, "ghost").ok).toBe(false);
  });

  it("reportPost 重复举报返回 duplicate", async () => {
    const feed = new SocialFeedService(createStubWorldService(), persistPath, mediaRoot);
    await feed.load();
    const post = feed.createPost("a", "x", "none", null);
    expect(post.ok).toBe(true);
    const pid = post.post.id;
    const r1 = feed.reportPost("rep", pid, "spam");
    expect(r1.ok).toBe(true);
    const r2 = feed.reportPost("rep", pid, "again");
    expect(r2.ok).toBe(true);
    expect(r2.duplicate).toBe(true);
  });

  it("帖子超过上限时淘汰最旧帖并清理其评论", async () => {
    const feed = new SocialFeedService(createStubWorldService(), persistPath, mediaRoot);
    await feed.load();
    let firstId = "";
    for (let i = 0; i < 401; i++) {
      const r = feed.createPost("author", `p-${i}`, "none", null);
      expect(r.ok).toBe(true);
      if (i === 0) firstId = r.post.id;
      if (i === 0) {
        expect(feed.addComment("c", r.post.id, "on-first").ok).toBe(true);
      }
    }
    await feed.flushPersist();
    const raw = JSON.parse(await readFile(persistPath, "utf8")) as {
      posts: { id: string }[];
      comments: { postId: string }[];
    };
    expect(raw.posts).toHaveLength(400);
    expect(raw.posts.some((p) => p.id === firstId)).toBe(false);
    expect(raw.comments.some((c) => c.postId === firstId)).toBe(false);
  });

  it("debounce 后定时落盘合并多次更新（真实计时，避免假计时阻塞 fs）", async () => {
    const feed = new SocialFeedService(createStubWorldService(), persistPath, mediaRoot);
    await feed.load();
    feed.createPost("a", "one", "none", null);
    feed.createPost("a", "two", "none", null);
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    const raw = JSON.parse(await readFile(persistPath, "utf8")) as { posts: unknown[] };
    expect(raw.posts.length).toBeGreaterThanOrEqual(2);
  });
});
