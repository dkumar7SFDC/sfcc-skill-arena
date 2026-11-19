export type Role = "dev" | "admin";
export type QuestionType = "single" | "multi";
export type Difficulty = "easy" | "medium" | "hard";

export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
  created_at: string;
}

export interface AuthedUser extends User {
  total_points: number;
  questions_mastered: number;
}

export interface Track {
  id: number;
  slug: string;
  title: string;
  description: string;
  icon: string;
  points_per_question: number;
  pass_percent: number;
  sort_order: number;
}

export interface QuestionRow {
  id: number;
  track_id: number;
  text: string;
  type: QuestionType;
  difficulty: Difficulty;
  points: number;
  explanation: string | null;
  sort_order: number;
}

export interface OptionRow {
  id: number;
  question_id: number;
  text: string;
  is_correct: number;
  sort_order: number;
}

export interface AttemptRow {
  id: number;
  user_id: number;
  track_id: number;
  started_at: string;
  finished_at: string | null;
  score: number;
  max_score: number;
  passed: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}
