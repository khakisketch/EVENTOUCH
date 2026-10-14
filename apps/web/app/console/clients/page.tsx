import ClientsList from "./ClientsList";

export default function ConsoleClientsPage() {
  return (
    <section className="console-page clients-page">
      <header className="console-page-header">
        <h1>고객사</h1>
      </header>
      <ClientsList />
    </section>
  );
}
