import type { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { environment } from '../../environments/environment';

import { AuthService } from './auth.service';

export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(AuthService);
  const token = auth.accessToken;
  const protectedRequest = isProtectedRequest(request.url);
  const outgoingRequest =
    token && protectedRequest ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : request;

  return next(outgoingRequest).pipe(
    catchError((error: HttpErrorResponse) => {
      if (protectedRequest && outgoingRequest.headers.has('Authorization') && error.status === 401) {
        auth.handleUnauthorized();
      }
      return throwError(() => error);
    }),
  );
};

function isProtectedRequest(url: string): boolean {
  const apiUrl = environment.apiUrl.replace(/\/+$/, '');
  return (
    url.startsWith(`${apiUrl}/products`) ||
    url.startsWith(`${apiUrl}/notifications`) ||
    url.startsWith(`${apiUrl}/auth/me`)
  );
}
