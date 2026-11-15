import type { HttpErrorResponse } from '@angular/common/http';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import type { Observable } from 'rxjs';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { tap } from 'rxjs/operators';

import { environment } from '../../environments/environment';
import type { AuthResponse, AuthUser, RegisterResponse } from '../models/auth.model';

export const AUTH_TOKEN_STORAGE_KEY = 'pantrypal.auth.token';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly authUrl = `${environment.apiUrl.replace(/\/+$/, '')}/auth`;

  private userSubject = new BehaviorSubject<AuthUser | null>(null);
  public user$ = this.userSubject.asObservable();
  private token: string | null = null;
  private initialization?: Promise<void>;

  public get accessToken(): string | null {
    return this.token;
  }

  public get isAuthenticated(): boolean {
    return this.token !== null && this.userSubject.value !== null;
  }

  public get currentUserId(): string | null {
    return this.userSubject.value?.id ?? null;
  }

  public initialize(): Promise<void> {
    this.initialization ??= this.restoreSession();
    return this.initialization;
  }

  public login(email: string, password: string): Observable<AuthResponse> {
    return this.http
      .post<AuthResponse>(`${this.authUrl}/login`, { email, password })
      .pipe(tap((response) => this.saveSession(response)));
  }

  public register(email: string, password: string): Observable<RegisterResponse> {
    return this.http.post<RegisterResponse>(`${this.authUrl}/register`, { email, password });
  }

  public logout(): void {
    this.clearSession();
    void this.router.navigateByUrl('/login', { replaceUrl: true });
  }

  public handleUnauthorized(): void {
    this.clearSession();
    void this.router.navigateByUrl('/login', { replaceUrl: true });
  }

  private async restoreSession(): Promise<void> {
    const storedToken = this.readToken();
    const tokenUser = storedToken ? this.readUnexpiredUser(storedToken) : null;
    if (!storedToken || !tokenUser) {
      this.clearSession();
      return;
    }

    this.token = storedToken;
    this.userSubject.next(tokenUser);

    try {
      const response = await firstValueFrom(
        this.http.get<{ user: AuthUser }>(`${this.authUrl}/me`, {
          headers: new HttpHeaders({ Authorization: `Bearer ${storedToken}` }),
        }),
      );
      this.userSubject.next(response.user);
    } catch (error) {
      if ((error as HttpErrorResponse).status === 401) {
        this.clearSession();
      }
      // Keep an unexpired local session during network outages; protected API calls still require server validation.
    }
  }

  private saveSession(response: AuthResponse): void {
    this.token = response.token;
    this.userSubject.next(response.user);
    try {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, response.token);
    } catch (error) {
      console.warn('[Auth] Could not persist the login token in localStorage.', error);
    }
  }

  private clearSession(): void {
    this.token = null;
    this.userSubject.next(null);
    try {
      localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    } catch (error) {
      console.warn('[Auth] Could not remove the login token from localStorage.', error);
    }
  }

  private readToken(): string | null {
    try {
      return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    } catch (error) {
      console.warn('[Auth] Could not read the login token from localStorage.', error);
      return null;
    }
  }

  private readUnexpiredUser(token: string): AuthUser | null {
    try {
      const payloadSegment = token.split('.')[1];
      if (!payloadSegment) return null;
      const payload = JSON.parse(atob(payloadSegment.replace(/-/g, '+').replace(/_/g, '/'))) as {
        sub?: unknown;
        email?: unknown;
        exp?: unknown;
      };
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.email !== 'string' ||
        typeof payload.exp !== 'number' ||
        payload.exp <= Math.floor(Date.now() / 1000)
      ) {
        return null;
      }
      return { id: payload.sub, email: payload.email };
    } catch {
      return null;
    }
  }
}
