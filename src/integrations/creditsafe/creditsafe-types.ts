/**
 * Raw shapes returned by the Creditsafe REST API. We normalise these into the
 * provider-neutral `CreditReport` before handing them to services.
 * See https://doc.creditsafe.com/ for full schema reference.
 */

export interface CreditsafeAuthResponse {
  token: string;
}

export interface CreditsafeCompanySearchResult {
  id: string;
  country: string;
  regNo: string;
  name: string;
  address?: { simpleValue?: string; postCode?: string };
  status: string;
  type: string;
  companyType?: string;
}

export interface CreditsafeCompanySearchResponse {
  totalSize: number;
  companies: CreditsafeCompanySearchResult[];
}

export interface CreditsafeReport {
  companyId: string;
  companySummary?: {
    businessName?: string;
    companyNumber?: string;
    country?: string;
    companyRegistrationNumber?: string;
    companyRegistrationDate?: string;
  };
  creditScore?: {
    currentCreditRating?: {
      providerValue?: { value?: string; min?: number; max?: number };
      commonValue?: string;
      commonDescription?: string;
      creditLimit?: { value?: number; currency?: string };
    };
    latestRatingChangeDate?: string;
  };
  additionalInformation?: {
    courtInformation?: {
      courtJudgments?: Array<{
        id?: string;
        date?: string;
        amount?: { value?: number; currency?: string };
        status?: string;
      }>;
      courtJudgmentSummary?: {
        exactNumberOfJudgments?: number;
        totalAmountOfJudgments?: { value?: number; currency?: string };
      };
    };
  };
}

export interface CreditsafeReportResponse {
  report: CreditsafeReport;
}
