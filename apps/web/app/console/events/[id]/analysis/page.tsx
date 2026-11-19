import PeriodAnalysisWorkspace from "./PeriodAnalysisWorkspace";

// 기간별 신청·입장 분석. 운영 현황은 오늘 현장만 보여 주고, 기간을 두고
// 돌아보는 집계는 이 화면이 맡는다.
export default async function ConsolePeriodAnalysisPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="console-page">
      <PeriodAnalysisWorkspace eventId={id} />
    </section>
  );
}
