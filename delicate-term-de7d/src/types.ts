export interface Env {
  PDFS: R2Bucket;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
  ALLOWED_ORIGIN: string;
}

export interface Issue {
  id: string;
  issue_number: number;
  issue_date: string;
  slug: string;
  cover_image_url: string | null;
  pdf_object_key: string;
  title: string | null;
  published: boolean;
  created_at: string;
  updated_at: string;
}
