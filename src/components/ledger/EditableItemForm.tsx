import type { ParsedLedgerItem } from '../../api/deepseek'
import { LEDGER_CATEGORIES, LEDGER_PAYMENTS } from '../../api/deepseek'

interface Props {
  value: ParsedLedgerItem
  onChange: (v: ParsedLedgerItem) => void
  onSave: () => void
  saveLabel?: string
}

const fieldInput: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #C0C4C4',
  fontSize: 13, fontFamily: 'var(--font-stack)', outline: 'none', color: '#111111',
  background: '#D8DADA', boxSizing: 'border-box', fontVariantNumeric: 'tabular-nums',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#A0A4A4', fontWeight: 500, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  )
}

/** AI 识别/解析结果的确认卡片：全部字段可编辑 + 保存 */
export default function EditableItemForm({ value, onChange, onSave, saveLabel = '保存这笔' }: Props) {
  const set = (patch: Partial<ParsedLedgerItem>) => onChange({ ...value, ...patch })
  const valid = (value.amount ?? 0) > 0

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="金额（元）">
          <input value={value.amount ? String(value.amount) : ''} inputMode="decimal"
            onChange={(e) => set({ amount: parseFloat(e.target.value) || 0 })} style={fieldInput} placeholder="0.00" />
        </Field>
        <Field label="分类">
          <select value={value.category} onChange={(e) => set({ category: e.target.value })} style={fieldInput}>
            {LEDGER_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="商家">
          <input value={value.merchant} onChange={(e) => set({ merchant: e.target.value })} style={fieldInput} placeholder="如：美团外卖" />
        </Field>
        <Field label="时间">
          <input type="date" value={value.time} onChange={(e) => set({ time: e.target.value })} style={fieldInput} />
        </Field>
        <Field label="支付方式">
          <select value={value.paymentMethod} onChange={(e) => set({ paymentMethod: e.target.value })} style={fieldInput}>
            {LEDGER_PAYMENTS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="备注">
          <input value={value.note} onChange={(e) => set({ note: e.target.value })} style={fieldInput} placeholder="可选" />
        </Field>
      </div>
      <button onClick={onSave} disabled={!valid} className="btn-primary"
        style={{ width: '100%', padding: '9px 0', marginTop: 12, opacity: valid ? 1 : 0.5 }}>
        {saveLabel}
      </button>
    </div>
  )
}
