import { CommonModule } from '@angular/common';
import type { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectorRef, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonContent,
  IonBadge,
  IonHeader,
  IonInput,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular';

import { AuthService } from '../services/auth.service';
import { NetworkService } from '../services/network-status.service';

@Component({
  selector: 'app-auth',
  templateUrl: './auth.page.html',
  styleUrls: ['./auth.page.scss'],
  imports: [
    CommonModule,
    FormsModule,
    IonButton,
    IonCard,
    IonCardContent,
    IonCardHeader,
    IonCardTitle,
    IonContent,
    IonBadge,
    IonHeader,
    IonInput,
    IonSpinner,
    IonTitle,
    IonToolbar,
  ],
})
export class AuthPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly network = inject(NetworkService);

  public email = '';
  public password = '';
  public isRegistering = false;
  public isSubmitting = false;
  public errorMessage = '';
  public successMessage = '';
  public networkStatus$ = this.network.status$;

  public submit(): void {
    this.errorMessage = '';
    this.successMessage = '';
    this.isSubmitting = true;

    if (this.isRegistering) {
      this.auth.register(this.email, this.password).subscribe({
        next: () => {
          this.isSubmitting = false;
          this.isRegistering = false;
          this.password = '';
          this.successMessage = 'Account created. Sign in with your new credentials.';
          this.changeDetector.markForCheck();
        },
        error: (error: HttpErrorResponse) => this.showError(error),
      });
      return;
    }

    this.auth.login(this.email, this.password).subscribe({
      next: () => {
        this.isSubmitting = false;
        void this.router.navigateByUrl('/products', { replaceUrl: true });
      },
      error: (error: HttpErrorResponse) => this.showError(error),
    });
  }

  public toggleMode(): void {
    this.isRegistering = !this.isRegistering;
    this.errorMessage = '';
    this.successMessage = '';
    this.password = '';
  }

  private showError(error: HttpErrorResponse): void {
    this.isSubmitting = false;
    this.errorMessage =
      error.status === 0
        ? 'Cannot reach the PantryPal API. On a phone, open the app using your computer’s Wi-Fi IP address, keep both devices on the same network, and allow ports 3000 and 4200 through the computer firewall.'
        : (error.error?.error ?? 'Authentication failed. Check your credentials and try again.');
    this.changeDetector.markForCheck();
  }
}
