# AI & Development Best Practices Reference

_Reference document for architecture workflow. Use these patterns when designing systems that involve AI/LLM integration, external API orchestration, or data pipelines._

## Architecture Patterns for AI Systems

### Complexity Ladder — Start Simple
1. **Direct Model Call**: Single LLM call suffices (summarization, classification) — no extra logic needed
2. **Single Agent + Tools**: One AI agent with tool access (search, DB) in a loop — good for domain-specific apps
3. **Multi-Agent Sequential**: Chain specialized agents in a pipeline — each refines output of previous
4. **Multi-Agent Parallel**: Independent agents on same input, merge results — for cross-domain analysis
5. **Coordinator/Handoff**: Orchestrator delegates to sub-agents — for complex multi-domain problems

**Rule**: Use the lowest complexity level that meets requirements. Don't add agent layers unless single-agent fails.

### Modularization
- Separate services by function: API gateway, data processing, AI inference, auth
- Use REST/gRPC between services; message queues (Kafka, BullMQ) for async
- Each service independently deployable and scalable

## Model & LLM Lifecycle

### Data Pipeline
- Record data provenance (source, time, version)
- Automate sanity checks (missing values, schema validation)
- Version datasets alongside code (DVC, database snapshots)

### Prompt/Model Management
- Log model version, prompt version, and hyperparameters for every inference
- Use a prompt registry (append-only) for trackability and rollback
- A/B test prompt changes: run old + new on same inputs, compare quality metrics
- Semantic versioning for prompts: major (schema change), minor (quality improvement), patch (wording fix)

### Evaluation
- Define business KPIs alongside technical metrics (accuracy, F1, fill rate)
- Backtest: compare predictions with ground truth collected after inference
- For extraction: track fill rate, error rate, rejection rate per batch
- Store evaluation results with model/prompt metadata

### Deployment
- Containerize with pinned dependencies
- Blue/green or canary releases for model changes
- Rollback plan documented: which model version to revert to

## Observability

### Structured Logging
- Use JSON logs for queryability: `{ level, module, action, metadata, timestamp }`
- Log inputs, outputs, and confidence scores (redact PII)
- Include request IDs for distributed tracing

### Drift Detection
- Monitor input feature distributions vs training data
- Track output distribution shifts (e.g., extraction fill rate trending down)
- Alert on significant drift — trigger retraining or prompt review

### Metrics to Track
- Prediction/extraction latency per call
- Throughput (calls/minute)
- Error rate (API failures, parse failures)
- Cost per batch (LLM tokens used)
- Quality proxies (fill rate, rejection rate)

## Security & Governance

### LLM-Specific Security
- All content sent to LLM is untrusted input — treat like form input
- Defend against prompt injection: explicit instructions to ignore embedded commands
- Validate LLM output schema before persisting — reject malformed responses
- Never pass LLM output to SQL, shell, or eval without sanitization
- Never expose system prompts in API responses or logs

### Access Control
- Least-privilege for all services
- API keys/secrets in vault, never in code
- Rotate credentials regularly
- Audit all model/data access

### Compliance
- Right to be forgotten (ability to purge candidate data)
- Data locality (keep data in required regions)
- Audit trails for all decisions
- Model explainability where required (LIME/SHAP for scoring models)

## Cost Optimization

### Hierarchy of Preference
1. Don't make the call (dedup, cache, skip)
2. Batch N items into 1 call
3. Use cheapest sufficient model (Haiku for extraction, not Opus)
4. Use stored procedures to combine operations server-side
5. Individual call as last resort

### Batching & Caching
- Batch inference requests where possible
- Cache embeddings and repeated computations
- Precompute common queries
- Use incremental sync (`since`/`lastRunAt`) to avoid reprocessing

### Model Selection
- Use smallest model that meets quality bar
- Quantized/distilled models for high-volume low-complexity tasks
- Reserve large models for complex reasoning only
- Track cost per batch and trend over time

## Testing AI Systems

### Unit Tests
- Test data transforms, feature engineering, metric calculations
- Test prompt construction logic
- Test output parsing and validation
- Test error handling for API failures and malformed responses

### Integration Tests
- Full pipeline: ingestion → extraction → persistence
- Use fixtures or synthetic data
- Validate no data loss or corruption across pipeline stages

### Adversarial Tests
- Prompt injection attempts in input content
- Malformed/missing fields in API responses
- Extremely large inputs (DoS)
- Fields that mimic output schema (poisoning)

### Quality Tests
- Compare new model/prompt against baseline on holdout set
- Statistical significance for improvements
- Fairness checks across data segments

## Pre-Merge Checklist (AI Projects)

- [ ] All new functions/types have type annotations
- [ ] Unit tests added/updated; coverage high on utility code
- [ ] Model/prompt version logged in output
- [ ] No hardcoded secrets or credentials
- [ ] LLM inputs truncated and sanitized
- [ ] LLM outputs validated before persistence
- [ ] Batch operations used where possible
- [ ] Error handling covers API failures, parse failures, timeout
- [ ] Monitoring/logging covers new inference paths
- [ ] Rollback plan documented for model changes
