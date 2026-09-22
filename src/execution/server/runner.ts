import { runSimulation } from '../../core/simulation.js';
import { extractSensMetrics } from '../../application/metrics.js';
import type { TaskSubmission } from '../../contracts/tasks';

process.on('disconnect', () => process.exit(0));
process.once('message', async (task: TaskSubmission) => {
  try {
    for (const [index, job] of task.jobs.entries()) {
      if (job.mode === 'js') throw new Error('JavaScript execution is disabled.');
      const result = runSimulation(job.params, job.strategy, job.overrides, 'dsl');
      await new Promise<void>((resolve, reject) => {
        if (!process.send) return reject(new Error('Missing parent connection.'));
        process.send({ type: 'point', index, result: task.kind === 'scan' ? extractSensMetrics(result) : result }, (error: Error | null) => error ? reject(error) : resolve());
      });
    }
    process.send?.({ type: 'done' }, () => { process.disconnect(); });
  } catch (error) {
    process.send?.({ type: 'failed', error: error instanceof Error ? error.message : String(error) }, () => { process.disconnect(); });
  }
});
