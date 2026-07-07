interface IOnboardingPayload {
  userName: string;
  website: string;
  brandName: string;
  niche: string;
  purpose: string;
  targetAudience: string;
  competitors: string[];
  description: string;
  // Video format for script/thumbnail generation — defaults to talking_head.
  format?: "talking_head" | "faceless";
}
