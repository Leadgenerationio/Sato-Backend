export interface XeroTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tenantId: string;
}

export interface XeroConnectionStatus {
  connected: boolean;
  tenantId?: string;
  expiresAt?: Date;
}
