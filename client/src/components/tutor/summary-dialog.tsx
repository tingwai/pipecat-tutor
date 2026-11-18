import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTutor, type Word } from "@/lib/tutor-store";
import { cn } from "@/lib/utils";

export function SummaryDialog() {
  const summary = useTutor((s) => s.summary);
  const words = useTutor((s) => s.words);
  const setSummary = useTutor((s) => s.setSummary);
  if (!summary) return null;

  const done = words.filter((w) => summary.practiced[w.id]);
  const todo = words.filter((w) => !summary.practiced[w.id]);

  return (
    <Dialog open onOpenChange={(open) => !open && setSummary(null)}>
      <DialogContent className="bg-secondary-background">
        <DialogHeader>
          <DialogTitle className="text-2xl">
            {done.length}/{words.length} words used
          </DialogTitle>
        </DialogHeader>
        <Section title="Used in conversation" words={done} className="bg-success" />
        <Section title="Not yet" words={todo} className="bg-secondary-background" />
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, words, className }: { title: string; words: Word[]; className: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-bold">{title}</div>
      <div className="flex flex-wrap gap-2">
        {words.length === 0 && <span className="text-muted-foreground text-sm">—</span>}
        {words.map((w) => (
          <span key={w.id} className={cn("rounded-base border-border border-2 px-2.5 py-1 text-sm font-bold", className)}>
            <span className="ja">{w.ja}</span> · {w.en}
          </span>
        ))}
      </div>
    </div>
  );
}
