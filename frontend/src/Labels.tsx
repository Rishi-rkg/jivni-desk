/** The envelope label and the patient card as they are printed. Also used for the preview in Printing. */
import { useState } from 'react';
import { Barcode, barcodeText } from './codes';
import { initials, shortDate } from './format';
import './print.css';

export interface LabelSettings {
  size: '2x2in' | '50x25mm' | '58x40mm' | 'custom';
  width_mm: number;
  height_mm: number;
  dosage_size: 'large' | 'medium';
  show_logo: boolean;
  show_address: boolean;
  show_phone: boolean;
  show_barcode: boolean;
  show_next_visit: boolean;
  show_medicines: boolean;
}
export interface PrintClinic {
  name: string;
  address: string;
  phone: string;
  email: string;
  registration_number: string;
  has_logo: boolean;
}
export interface LabelEnvelope {
  number: number;
  dosage_line: string;
  dosage: Record<string, string>;
  medicines: string[];
}
export interface LabelData {
  clinic: PrintClinic;
  patient: { id: string; name: string; code: string };
  date: string;
  next_visit: string;
  envelopes: LabelEnvelope[];
  settings: LabelSettings;
}
export const LABEL_SIZES: Record<string, [number, number]> = {
  '2x2in': [50.8, 50.8],
  '50x25mm': [50, 25],
  '58x40mm': [58, 40],
};
/** Width and height in millimetres for a label layout. */
export function labelSize(settings: Pick<LabelSettings, 'size' | 'width_mm' | 'height_mm'>): [number, number] {
  return LABEL_SIZES[settings.size] ?? [settings.width_mm, settings.height_mm];
}

/**
 * The dosage in two parts, as it reads best on a small label: "4 tabs, twice daily" in large type,
 * then "before meals · 14 days" under it. Falls back to the whole sentence when the parts are not known.
 */
export function dosageParts(envelope: Pick<LabelEnvelope, 'dosage_line' | 'dosage'>): [string, string] {
  const d = envelope.dosage ?? {};
  const main = [[d.amount, d.unit].filter(Boolean).join(' '), d.frequency].filter(Boolean).join(', ');
  const rest = [d.timing, d.length && [d.length, d.period].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  if (!d.amount || !d.frequency) return [envelope.dosage_line, ''];
  return [main, rest];
}

export function ClinicLogo({ clinic, className }: { clinic: PrintClinic; className: string }) {
  const [missing, setMissing] = useState(!clinic.has_logo);
  return missing ? (
    <span className={className}>{initials(clinic.name)}</span>
  ) : (
    <img className={className} alt="" src="/api/v1/clinic/logo/" onError={() => setMissing(true)} />
  );
}

export function EnvelopeLabel({
  data,
  envelope,
  settings = data.settings,
}: {
  data: LabelData;
  envelope: LabelEnvelope;
  settings?: LabelSettings;
}) {
  const [width, height] = labelSize(settings);
  const compact = height < 38;
  const [main, rest] = dosageParts(envelope);
  const nameSize = data.patient.name.length > 30 ? 7.5 : data.patient.name.length > 22 ? 8.5 : 10;
  const doseSize =
    (settings.dosage_size === 'medium' ? 9.5 : 10.5) -
    (main.length > 44 ? 2 : main.length > 30 ? 1 : 0) -
    (compact ? 2 : 0);
  const total = data.envelopes.length;
  const firstAddressLine = data.clinic.address.split('\n').filter(Boolean).join(', ');
  return (
    <div
      className={`label ${compact ? 'compact' : ''}`}
      style={{ width: `${width}mm`, height: `${height}mm` }}
      role="img"
      aria-label={`Label for envelope ${envelope.number}`}
    >
      <div className="l-head">
        {settings.show_logo && !compact && <ClinicLogo clinic={data.clinic} className="l-logo" />}
        <div className="l-who">
          <div className="l-clinic">{data.clinic.name}</div>
          {settings.show_address && !compact && firstAddressLine && <div className="l-addr">{firstAddressLine}</div>}
          {settings.show_phone && !compact && data.clinic.phone && <div className="l-addr">{data.clinic.phone}</div>}
        </div>
      </div>
      <div className="l-patient" style={{ fontSize: `${compact ? Math.min(nameSize, 8.5) : nameSize}pt` }}>
        {data.patient.name}
      </div>
      <div className="l-dose" style={{ fontSize: `${doseSize}pt` }}>
        {main}
        {rest && <small>{rest}</small>}
        {!!envelope.medicines.length && <small className="l-medicines">{envelope.medicines.join(' + ')}</small>}
      </div>
      <div className="l-dates">
        <div>
          <span>Date</span>
          <b>{shortDate(data.date)}</b>
        </div>
        {settings.show_next_visit && (
          <div>
            <span>Next visit</span>
            <b>{data.next_visit ? shortDate(data.next_visit) : 'As needed'}</b>
          </div>
        )}
      </div>
      {settings.show_barcode && data.patient.code && (
        <Barcode className="l-code" value={barcodeText(data.patient.code)} />
      )}
      <div className="l-foot">
        <span>{data.patient.code}</span>
        <span>{total > 1 ? `${envelope.number} of ${total}` : ''}</span>
      </div>
    </div>
  );
}

export interface CardData {
  clinic: PrintClinic;
  patient: { id: string; name: string; code: string };
  settings: { show_phone: boolean; show_address: boolean };
}

export function PatientCard({ data }: { data: CardData }) {
  return (
    <div className="p-card" role="img" aria-label={`Patient card for ${data.patient.name}`}>
      <div className="p-card-head">
        <ClinicLogo clinic={data.clinic} className="p-card-logo" />
        <div>
          <strong>{data.clinic.name}</strong>
          {data.settings.show_address && data.clinic.address && (
            <span>{data.clinic.address.split('\n').filter(Boolean).join(', ')}</span>
          )}
          {data.settings.show_phone && data.clinic.phone && <span>{data.clinic.phone}</span>}
        </div>
      </div>
      <div className="p-card-name">{data.patient.name}</div>
      {data.patient.code && <Barcode className="p-card-code" value={barcodeText(data.patient.code)} />}
      <div className="p-card-foot">
        <span>{data.patient.code}</span>
        <span>Please bring this card to every visit</span>
      </div>
    </div>
  );
}
