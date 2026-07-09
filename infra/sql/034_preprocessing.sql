CREATE TABLE IF NOT EXISTS item_preprocessing_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_item_id UUID NOT NULL REFERENCES template_items(id) ON DELETE CASCADE,
    step_order INT NOT NULL DEFAULT 1,
    step_type TEXT NOT NULL CHECK (step_type IN ('change_per_second','multiplier','jsonpath','regex')),
    params JSONB NOT NULL DEFAULT '{}'
);
