import HomeShell from "./HomeShell";

// A new event gets a new shell instance: its state, pending loads and in-tab
// bearer never carry over from a previously rendered slug.
export default async function HomePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <HomeShell key={slug} slug={slug} />;
}
