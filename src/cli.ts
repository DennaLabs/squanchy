import { Command } from "commander";

export async function run(argv: string[]): Promise<void> {
  const program = new Command();
  program.name("squanchy").description("AI code review for PRs").version("0.1.0");
  await program.parseAsync(argv);
}
