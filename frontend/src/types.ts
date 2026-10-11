export type Role = 'owner' | 'admin' | 'clinician' | 'assistant' | 'reception' | 'billing';
export type FeatureName =
  | 'appointments'
  | 'billing'
  | 'product_sales'
  | 'show_gst'
  | 'messages'
  | 'auto_reminders'
  | 'library'
  | 'stock_control'
  | 'ai_drafting'
  | 'two_step';
export type Features = Record<FeatureName, boolean>;
export interface Membership {
  records_unlocked?: boolean;
  clinic_id: string;
  clinic_name: string;
  role: Role;
  time_zone?: string;
  currency?: string;
  features?: Partial<Features>;
}
export interface Session {
  user: { id: string; username: string; name: string };
  clinic_id: string;
  memberships: Membership[];
  csrf_token: string;
  idle_timeout_seconds?: number;
}
export interface Address {
  line1: string;
  line2: string;
  city: string;
  region: string;
  postal_code: string;
  country: string;
}
export interface Photo {
  id: string;
  mime_type: string;
  byte_size: number;
  created_at: string;
}
export interface Patient {
  id: string;
  identifier?: string | null;
  whatsapp_number?: string;
  first_name: string;
  middle_name: string;
  last_name: string;
  date_of_birth: string;
  gender: string;
  phone: string;
  email: string;
  address: Address | null;
  photos: Photo[];
  archived_at: string | null;
  created_at: string;
}
export interface Note {
  id: string;
  patient: string;
  kind?: 'clinical' | 'remember';
  body: string;
  author_name: string;
  amends: string | null;
  created_at: string;
}
export interface Observation {
  id?: string;
  kind: 'height' | 'weight';
  value: string;
  unit: 'cm' | 'kg';
  measured_at?: string;
}
export interface PrescriptionItem {
  id?: string;
  medicine_name_snapshot: string;
  potency: string;
  dose: string;
  frequency: string;
  duration: string;
  instructions: string;
  quantity: number | null;
}
export interface Prescription {
  id?: string;
  instructions: string;
  dosage_line?: string;
  items: PrescriptionItem[];
}
export interface Encounter {
  id: string;
  patient: string;
  clinician_name: string;
  occurred_at: string;
  chief_complaint: string;
  symptoms: string;
  history: string;
  assessment: string;
  internal_notes?: string;
  follow_up_date: string | null;
  visit_type?: string;
  progress?: string;
  observations: Observation[];
  prescriptions: Prescription[];
}
export interface Timeline {
  encounters: Encounter[];
  notes: Note[];
  limit_per_type: number;
}
export interface ClinicSettings {
  id: string;
  name: string;
  time_zone: string;
  address: string;
  phone: string;
  email: string;
  tax_identifier: string;
  currency: string;
  registration_number: string;
  upi_id: string;
  invoice_prefix: string;
  lock_after_minutes: number;
  features: Features;
  has_logo: boolean;
}
export interface AuditEvent {
  id: string;
  actor: string | null;
  actor_username: string | null;
  action: string;
  outcome: 'success' | 'denied' | 'failed';
  resource_type: string;
  resource_id: string | null;
  source_ip: string | null;
  request_id: string | null;
  occurred_at: string;
}
export interface Page<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}
export const displayName = (p: Patient) => [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ');
export const canReadClinical = (r: Role) => ['owner', 'clinician', 'assistant'].includes(r);
export const canWriteClinical = (r: Role) => ['owner', 'clinician'].includes(r);
export const canAdministerClinic = (r: Role) => ['owner', 'admin'].includes(r);
export const canWriteDemographics = (r: Role) => ['owner', 'clinician', 'assistant', 'reception'].includes(r);
export interface BackupPlace {
  id: string;
  name: string;
  kind: 'local' | 'nas' | 'cloud';
  folder: string;
  last_ok_at: string | null;
  last_error: string;
  reachable: boolean;
  free_bytes: number | null;
}
export interface BackupRun {
  id: string;
  kind: 'manual' | 'automatic';
  started_at: string;
  finished_at: string | null;
  file_name: string;
  byte_size: number;
  places: { place: string; name: string; ok: boolean; error?: string }[];
  ok: boolean;
  error: string;
  verified_at: string | null;
  verified_ok: boolean | null;
}
export interface BackupPolicy {
  automatic: boolean;
  frequency: 'daily' | 'twice_daily' | 'weekly';
  at: string;
  keep_daily_days: number;
  keep_monthly_months: number;
  warn_after_days: number;
}
export interface BackupOverview {
  status: { last_ok_at: string | null; overdue: boolean; due: boolean; problem: string };
  policy: BackupPolicy;
  places: BackupPlace[];
  runs: BackupRun[];
}
export const canManageBackups = (r: Role) => r === 'owner';

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  clinician: 'Doctor',
  assistant: 'Clinical assistant',
  reception: 'Reception',
  billing: 'Billing',
  admin: 'Administrator',
};
/** A switch counts as on unless the server says it is off, so an older server hides nothing. */
export const featureOn = (member: Membership | undefined, name: FeatureName) => member?.features?.[name] !== false;
export const canUseAppointments = (r: Role) => ['owner', 'clinician', 'assistant', 'reception'].includes(r);
export const canUseMessages = (r: Role) => ['owner', 'clinician', 'reception'].includes(r);
export const canUseBilling = (r: Role) => ['owner', 'clinician', 'reception', 'billing'].includes(r);
export const canTakePayments = (r: Role) => ['owner', 'reception', 'billing'].includes(r);
export const canOpenSettings = (r: Role) => ['owner', 'admin'].includes(r);
