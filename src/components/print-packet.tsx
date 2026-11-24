import type { Paper, PrintDocument } from '@/lib/print-documents';

/** The shared layout of specs/print-templates.md: same elements, classes and row order. */
export function PrintPacket({ documents, paper }: { documents: PrintDocument[]; paper: Paper }) {
  return (
    <main className="packet" data-paper={paper}>
      {documents.map((doc) => (
        <article className="sheet" key={doc.key}>
          <header className="pair">
            <div>
              <h1>{doc.title}</h1>
              <strong>{doc.issuerName}</strong>
              <div>{doc.issuerAddress}</div>
              <div>GSTIN {doc.issuerGstin}</div>
            </div>
            <div>
              <strong>{doc.number}</strong>
              <div>{doc.issueDate}</div>
              <div>{doc.copyLabel}</div>
              {doc.linked.map((row) => <div key={row.label + row.value}>{row.label} · {row.value}</div>)}
            </div>
          </header>
          <section className="pair ruled">
            {doc.parties.map((party) => (
              <div key={party.role}>
                <b>{party.role}</b>
                <div>{party.name}</div>
                <div>{party.address}</div>
                <div>{party.stateAndCode}</div>
                <div>{party.registration}</div>
              </div>
            ))}
          </section>
          <section className="strip">
            {doc.facts.map((fact) => <span key={fact.label}><b>{fact.label}</b> {fact.value}</span>)}
          </section>
          {doc.declarationText.map((text) => <p key={text}>{text}</p>)}
          <table className="lines">
            <colgroup><col className="item" /><col className="qty" /><col className="rate" /><col className="amount" /></colgroup>
            <thead>
              <tr><th className="ref" colSpan={4}>{doc.title} · {doc.number} · {doc.copyLabel}</th></tr>
              <tr>{doc.columns.map((column) => <th scope="col" className={column.align} key={column.label}>{column.label}</th>)}</tr>
            </thead>
            <tbody>
              {doc.items.map((item, i) => (
                <tr key={i}>
                  <td>{item.description}<small>{item.codeLabel} {item.code}</small></td>
                  <td className="num">{item.quantity}<small>{item.quantityDetail}</small></td>
                  <td className="num">{item.third}<small>{item.thirdDetail}</small></td>
                  <td className="num">{item.fourth}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {doc.taxBand ? (
            <table className="tax">
              <thead>
                <tr><th className="ref" colSpan={doc.taxBand.count}>GST summary · {doc.number}</th></tr>
                <tr>{doc.taxBand.columns.map((column) => <th scope="col" className={column.align} key={column.label}>{column.label}</th>)}</tr>
              </thead>
              <tbody>
                {doc.taxBand.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td className={cell.align} key={j}>{cell.text}</td>)}</tr>)}
              </tbody>
            </table>
          ) : null}
          <footer className="keep closing">
            <b>{doc.closingTitle} · {doc.number}</b>
            {doc.closingRows.map((row, i) => <div className="sum" key={i}><span>{row.label}</span><strong>{row.value}</strong></div>)}
            {doc.total ? <div className="sum total"><b>{doc.total.label}</b><b>{doc.total.value}</b></div> : null}
            {doc.words ? <p><b>{doc.words.label}</b> {doc.words.value}</p> : null}
            <div className="pair signs">
              {doc.signatures.map((signature) => (
                <div key={signature.role}>
                  <div>{signature.organisation}</div>
                  <div className="signline">{signature.role}</div>
                  <small>{signature.nameDateLabel}</small>
                </div>
              ))}
            </div>
          </footer>
        </article>
      ))}
    </main>
  );
}
