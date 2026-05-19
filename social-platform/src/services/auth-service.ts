import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';

export type UserType = 'human' | 'agent';

export interface User {
  id: string;
  username: string;
  email?: string;
  passwordHash: string;
  userType: UserType;
  displayName: string;
  avatar?: string;
  bio?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthToken {
  userId: string;
  username: string;
  userType: UserType;
}

const JWT_SECRET = process.env.JWT_SECRET || 'social-platform-secret-key-change-in-production';
const TOKEN_EXPIRY = '7d';

export class AuthService {
  private users: Map<string, User> = new Map();
  private usernameIndex: Map<string, string> = new Map(); // username -> userId
  private persistPath: string;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(persistPath: string = join(process.cwd(), 'data', 'users.json')) {
    this.persistPath = persistPath;
  }

  async load(): Promise<void> {
    try {
      const data = await readFile(this.persistPath, 'utf8');
      const users = JSON.parse(data) as User[];
      for (const user of users) {
        this.users.set(user.id, user);
        this.usernameIndex.set(user.username.toLowerCase(), user.id);
      }
      console.log(`[AuthService] Loaded ${users.length} users`);
    } catch (error) {
      console.log('[AuthService] No existing users file, starting fresh');
    }
  }

  async register(
    username: string,
    password: string,
    userType: UserType,
    displayName: string,
    email?: string
  ): Promise<{ ok: true; user: User; token: string } | { ok: false; reason: string }> {
    const normalizedUsername = username.toLowerCase().trim();
    
    if (this.usernameIndex.has(normalizedUsername)) {
      return { ok: false, reason: '用户名已存在' };
    }

    if (password.length < 6) {
      return { ok: false, reason: '密码长度至少6位' };
    }

    if (!displayName || displayName.trim().length === 0) {
      return { ok: false, reason: '显示名称不能为空' };
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const now = new Date().toISOString();

    const user: User = {
      id: `user_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      username: normalizedUsername,
      email: email?.trim() || undefined,
      passwordHash,
      userType,
      displayName: displayName.trim(),
      avatar: undefined,
      bio: undefined,
      createdAt: now,
      updatedAt: now,
    };

    this.users.set(user.id, user);
    this.usernameIndex.set(normalizedUsername, user.id);

    const token = this.generateToken(user);
    void this.schedulePersist();

    return { ok: true, user: this.sanitizeUser(user), token };
  }

  async login(
    username: string,
    password: string
  ): Promise<{ ok: true; user: User; token: string } | { ok: false; reason: string }> {
    const normalizedUsername = username.toLowerCase().trim();
    const userId = this.usernameIndex.get(normalizedUsername);

    if (!userId) {
      return { ok: false, reason: '用户名或密码错误' };
    }

    const user = this.users.get(userId);
    if (!user) {
      return { ok: false, reason: '用户名或密码错误' };
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return { ok: false, reason: '用户名或密码错误' };
    }

    const token = this.generateToken(user);
    return { ok: true, user: this.sanitizeUser(user), token };
  }

  verifyToken(token: string): AuthToken | null {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as AuthToken;
      return decoded;
    } catch {
      return null;
    }
  }

  getUserById(userId: string): User | undefined {
    const user = this.users.get(userId);
    return user ? this.sanitizeUser(user) : undefined;
  }

  getUserByUsername(username: string): User | undefined {
    const userId = this.usernameIndex.get(username.toLowerCase());
    if (!userId) return undefined;
    const user = this.users.get(userId);
    return user ? this.sanitizeUser(user) : undefined;
  }

  updateUserProfile(
    userId: string,
    updates: Partial<Pick<User, 'displayName' | 'avatar' | 'bio'>>
  ): { ok: true; user: User } | { ok: false; reason: string } {
    const user = this.users.get(userId);
    if (!user) {
      return { ok: false, reason: '用户不存在' };
    }

    if (updates.displayName !== undefined) {
      if (!updates.displayName || updates.displayName.trim().length === 0) {
        return { ok: false, reason: '显示名称不能为空' };
      }
      user.displayName = updates.displayName.trim();
    }

    if (updates.avatar !== undefined) {
      user.avatar = updates.avatar;
    }

    if (updates.bio !== undefined) {
      user.bio = updates.bio;
    }

    user.updatedAt = new Date().toISOString();
    void this.schedulePersist();

    return { ok: true, user: this.sanitizeUser(user) };
  }

  private generateToken(user: User): string {
    const payload: AuthToken = {
      userId: user.id,
      username: user.username,
      userType: user.userType,
    };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
  }

  private sanitizeUser(user: User): User {
    const { passwordHash, ...sanitized } = user;
    return sanitized as User;
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistToDisk();
    }, 500);
  }

  private async persistToDisk(): Promise<void> {
    const users = Array.from(this.users.values());
    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      await writeFile(this.persistPath, JSON.stringify(users, null, 2), 'utf8');
    } catch (error) {
      console.error('[AuthService] Persist failed:', error);
    }
  }
}
