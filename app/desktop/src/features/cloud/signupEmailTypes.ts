export type CloudSignupCodeChallenge = {
  verificationId: string;
  expiresAt: string;
  retryAfterSeconds: number;
};

export type CloudAccountEmailVerificationInput = {
  verificationId: string;
  verificationCode: string;
};
