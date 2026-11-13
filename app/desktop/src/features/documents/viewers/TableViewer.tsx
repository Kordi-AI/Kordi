import { useMemo } from 'react';

import { parseDelimited, TABLE_VIEWER_MAX_ROWS } from './delimitedText';

const NUMERIC = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/;

/** A column reads as numbers when every filled cell is one; those columns align right. */
function numericColumns(rows: string[][], width: number) {
  return Array.from({ length: width }, (_, column) => {
    const filled = rows.map((row) => row[column]?.trim() ?? '').filter(Boolean);
    return filled.length > 0 && filled.every((cell) => NUMERIC.test(cell));
  });
}

/**
 * A delimited file as a table that fills the panel: a sticky header in normal case, row numbers,
 * and numeric columns aligned right.
 */
export function TableViewer({ text, delimiter }: { text: string; delimiter: string }) {
  const { header, body, width, numeric, total } = useMemo(() => {
    const rows = parseDelimited(text, delimiter);
    const [first = [], ...rest] = rows;
    const columns = Math.max(first.length, ...rest.slice(0, TABLE_VIEWER_MAX_ROWS).map((row) => row.length));
    const shown = rest.slice(0, TABLE_VIEWER_MAX_ROWS);
    return { header: first, body: shown, width: columns, numeric: numericColumns(shown, columns), total: rest.length };
  }, [text, delimiter]);

  if (width === 0) return <p className="app-viewer-empty">This table is empty.</p>;
  return (
    <div className="app-table-viewer" data-table-viewer="" tabIndex={0} aria-label="Table">
      <table>
        <thead>
          <tr>
            <th className="app-table-viewer-row-number" aria-label="Row" />
            {Array.from({ length: width }, (_, column) => (
              <th key={column} className={numeric[column] ? 'app-table-viewer-numeric' : undefined}>{header[column] || `Column ${column + 1}`}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <td className="app-table-viewer-row-number">{rowIndex + 1}</td>
              {Array.from({ length: width }, (_, column) => (
                <td key={column} className={numeric[column] ? 'app-table-viewer-numeric' : undefined}>{row[column] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {total > body.length ? <p className="app-viewer-note">Showing the first {body.length.toLocaleString()} of {total.toLocaleString()} rows.</p> : null}
    </div>
  );
}
