"""
Functions for creating NN models.
"""
import tensorflow as tf
from .ParamsClasses import TrainingParams
from .models.feedforward import FeedforwardFactory, FeedforwardWithResidualFactory


#################################################
# Create tf.keras.Model based on TrainingParams #
#################################################


def get_model_factory(training_parameters):
    """
    Create model factory based on `training_parameters`.

    Parameters
    ----------
    training_parameters : TrainingParams

    Returns
    -------
    tf.keras.Model
    """
    if training_parameters.architecture == "feedforward":
        return FeedforwardFactory
    elif training_parameters.architecture == "feedforward_residual":
        return FeedforwardWithResidualFactory
    else:
        raise ValueError(f"Unknown network architecture: '{training_parameters.architecture}'")


################################################################
# Create tf.keras.optimizers.Optimizer based on TrainingParams #
################################################################


def get_optimizer(training_parameters):
    adam_params = {}
    if hasattr(training_parameters, "learning_rate") and isinstance(training_parameters.learning_rate, float):
        adam_params["learning_rate"] = training_parameters.learning_rate

    return tf.keras.optimizers.Adam(**adam_params)
