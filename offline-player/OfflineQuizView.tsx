import React, { useMemo, useState } from 'react';
import { CheckCircle2, HelpCircle, RotateCcw, XCircle } from 'lucide-react';
import type { QuizQuestion } from '@/lib/types/stage';

type Answers = Record<string, string[]>;

function isChoiceQuestion(question: QuizQuestion) {
  return question.type === 'single' || question.type === 'multiple';
}

function arraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

export function OfflineQuizView({
  questions,
  title,
}: {
  readonly questions: QuizQuestion[];
  readonly title?: string;
}) {
  const [answers, setAnswers] = useState<Answers>({});
  const [submitted, setSubmitted] = useState(false);

  const totalPoints = useMemo(
    () => questions.reduce((sum, question) => sum + (question.points ?? 1), 0),
    [questions],
  );

  const earnedPoints = useMemo(() => {
    if (!submitted) return 0;
    return questions.reduce((sum, question) => {
      if (!isChoiceQuestion(question) || !question.answer) return sum;
      return arraysEqual(answers[question.id] ?? [], question.answer) ? sum + (question.points ?? 1) : sum;
    }, 0);
  }, [answers, questions, submitted]);

  const updateAnswer = (question: QuizQuestion, value: string) => {
    if (submitted) return;
    setAnswers((current) => {
      if (question.type === 'single') return { ...current, [question.id]: [value] };
      const existing = current[question.id] ?? [];
      const next = existing.includes(value)
        ? existing.filter((item) => item !== value)
        : [...existing, value];
      return { ...current, [question.id]: next };
    });
  };

  const reset = () => {
    setAnswers({});
    setSubmitted(false);
  };

  return (
    <div className="omaic-quiz">
      <div className="omaic-quiz-shell">
        <header className="omaic-quiz-header">
          <div className="omaic-quiz-icon">
            <HelpCircle aria-hidden="true" />
          </div>
          <div>
            <h2>{title || 'Knowledge Check'}</h2>
            <p>
              {questions.length} questions · {totalPoints} points
            </p>
          </div>
          {submitted && (
            <div className="omaic-quiz-score">
              {earnedPoints}/{totalPoints}
            </div>
          )}
        </header>

        <div className="omaic-quiz-list">
          {questions.map((question, index) => {
            const selected = answers[question.id] ?? [];
            const correct = question.answer ? arraysEqual(selected, question.answer) : null;
            return (
              <section className="omaic-quiz-card" key={question.id}>
                <div className="omaic-quiz-question-head">
                  <span className="omaic-quiz-index">{index + 1}</span>
                  <div>
                    <div className="omaic-quiz-question-type">
                      {question.type === 'multiple'
                        ? 'Multiple choice'
                        : question.type === 'single'
                          ? 'Single choice'
                          : 'Short answer'}{' '}
                      · {question.points ?? 1} points
                    </div>
                    <h3>{question.question}</h3>
                  </div>
                  {submitted && correct !== null && (
                    <div className={correct ? 'omaic-quiz-result-good' : 'omaic-quiz-result-bad'}>
                      {correct ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}
                    </div>
                  )}
                </div>

                {question.options?.length ? (
                  <div className="omaic-quiz-options">
                    {question.options.map((option) => {
                      const isSelected = selected.includes(option.value);
                      const isCorrectOption = submitted && question.answer?.includes(option.value);
                      return (
                        <button
                          type="button"
                          key={option.value}
                          className={[
                            'omaic-quiz-option',
                            isSelected ? 'omaic-quiz-option-selected' : '',
                            isCorrectOption ? 'omaic-quiz-option-correct' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          onClick={() => updateAnswer(question, option.value)}
                        >
                          <span>{option.value}</span>
                          <strong>{option.label.replace(/^[A-Z]\.\s*/, '')}</strong>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <textarea
                    className="omaic-quiz-textarea"
                    value={selected[0] ?? ''}
                    disabled={submitted}
                    placeholder="Write your answer"
                    onChange={(event) =>
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: [event.target.value],
                      }))
                    }
                  />
                )}

                {submitted && question.analysis && (
                  <div className="omaic-quiz-analysis">
                    <strong>Analysis</strong>
                    <p>{question.analysis}</p>
                  </div>
                )}
              </section>
            );
          })}
        </div>

        <footer className="omaic-quiz-actions">
          {submitted ? (
            <button type="button" className="omaic-quiz-secondary" onClick={reset}>
              <RotateCcw aria-hidden="true" />
              Retry
            </button>
          ) : (
            <button type="button" className="omaic-quiz-primary" onClick={() => setSubmitted(true)}>
              Submit answers
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
