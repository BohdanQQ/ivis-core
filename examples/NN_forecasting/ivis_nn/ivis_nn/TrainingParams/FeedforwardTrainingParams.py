from .TrainingParams import TrainingParams


class FeedforwardTrainingParams(TrainingParams):
    """Class representing the parameters for a feedforward model for `run_training` function."""

    def __init__(self):
        super().__init__()
        self.hidden_layers = []   # Sizes of hidden layers.

    def __str__(self):
        return super().__str__() + \
            "\nHidden layers:" + \
            str(self.hidden_layers)
